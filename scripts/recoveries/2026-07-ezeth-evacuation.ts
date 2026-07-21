/* eslint-disable no-console */
import minimist from "minimist";
import { PUBLIC_NETWORKS, HYPERLANE_NO_DOMAIN_ID } from "@across-protocol/constants";
import {
  BigNumber,
  CHAIN_IDs,
  Contract,
  ERC20,
  EvmAddress,
  TOKEN_SYMBOLS_MAP,
  assert,
  blockExplorerLink,
  bnZero,
  createFormatFunction,
  ethers,
  getNativeTokenSymbol,
  getNetworkName,
  getProvider,
  isDefined,
  retrieveSignerFromCLIArgs,
} from "../../src/utils";
import { HYPERLANE_ROUTERS, HYPERLANE_DEFAULT_FEE_CAP, HYPERLANE_FEE_CAP_OVERRIDES } from "../../src/common";
import HYPERLANE_ROUTER_ABI from "../../src/common/abi/IHypXERC20Router.json";
import { askYesNoQuestion } from "../utils";

// Throwaway script to evacuate stranded ezETH inventory back to Ethereum mainnet via
// Renzo's Hyperlane xERC20 warp routes — the same routes the HyperlaneXERC20BridgeL2
// adapter uses. ezETH routes are sunset on Across, so remaining L2 relayer balances
// are dead inventory (see #3596 "Deliberately NOT removed").
//
// Scans every chain with a configured ezETH Hyperlane router (except mainnet) and, for
// each non-zero balance held by the connected signer, sanity-checks the router wiring
// on-chain (wrappedToken, enrolled mainnet router, fee cap), then either prints the
// transaction plan (default) or executes approve (if needed) + transferRemote (--sendTx).
//
// Note the Hyperlane message fee is paid in the L2's native token (quoted via
// quoteGasPayment), so the signer needs a small native balance on each chain.
//
// Example run:
// tsx ./scripts/recoveries/2026-07-ezeth-evacuation.ts --wallet void --address 0x428AB2BA90Eba0a4Be7aF34C9Ac451ab061AC010  # Dry run
// tsx ./scripts/recoveries/2026-07-ezeth-evacuation.ts --wallet gckms --keys bot2 --sendTx                                 # Execute
// Optional: --chainId 81457 (single chain), --recipient 0x... (mainnet recipient other than the signer)

const args = minimist(process.argv.slice(2), {
  string: ["chainId", "recipient"],
  boolean: ["sendTx"],
});

const { MAINNET } = CHAIN_IDs;
const L1_EZETH = TOKEN_SYMBOLS_MAP.ezETH.addresses[MAINNET];
// Gas headroom for the transferRemote transaction itself, on top of the Hyperlane fee.
const GAS_UNITS_BUFFER = BigNumber.from(300_000);

interface EvacuationPlan {
  chainId: number;
  chainName: string;
  token: Contract;
  router: Contract;
  balance: BigNumber;
  fee: BigNumber;
  needsApproval: boolean;
  gasShortfall?: string;
}

async function run(): Promise<void> {
  const sendTransactions = args.sendTx === true;

  const baseSigner = await retrieveSignerFromCLIArgs();
  const signerAddr = await baseSigner.getAddress();

  const recipient = ethers.utils.getAddress(args.recipient ?? signerAddr);
  const recipientBytes32 = EvmAddress.from(recipient).toBytes32();

  const destinationDomain = PUBLIC_NETWORKS[MAINNET].hypDomainId;
  assert(destinationDomain !== HYPERLANE_NO_DOMAIN_ID, "Hyperlane domain id not set for mainnet");

  const l1Router = HYPERLANE_ROUTERS[MAINNET]?.[L1_EZETH];
  assert(isDefined(l1Router), "No mainnet Hyperlane router configured for ezETH");

  const chainIds = isDefined(args.chainId)
    ? String(args.chainId).split(",").map(Number)
    : Object.keys(HYPERLANE_ROUTERS)
        .map(Number)
        .filter((chainId) => {
          const l2Token = TOKEN_SYMBOLS_MAP.ezETH.addresses[chainId];
          return chainId !== MAINNET && isDefined(l2Token) && isDefined(HYPERLANE_ROUTERS[chainId][l2Token]);
        });

  console.log(`Connected as ${signerAddr}`);
  console.log(`Mainnet recipient: ${recipient}`);
  console.log(`Scanning for ezETH on: ${chainIds.map((chainId) => getNetworkName(chainId)).join(", ")}\n`);

  const formatter = createFormatFunction(2, 4, false, TOKEN_SYMBOLS_MAP.ezETH.decimals);
  const plans: EvacuationPlan[] = [];

  for (const chainId of chainIds) {
    const chainName = getNetworkName(chainId);
    try {
      const l2TokenAddr = TOKEN_SYMBOLS_MAP.ezETH.addresses[chainId];
      assert(isDefined(l2TokenAddr), "ezETH is not deployed on this chain");
      const routerAddr = HYPERLANE_ROUTERS[chainId]?.[l2TokenAddr];
      assert(isDefined(routerAddr), "No ezETH Hyperlane router configured for this chain");

      const provider = await getProvider(chainId);
      const signer = baseSigner.connect(provider);
      const token = new Contract(l2TokenAddr, ERC20.abi, signer);
      const router = new Contract(routerAddr, HYPERLANE_ROUTER_ABI, signer);

      const balance: BigNumber = await token.balanceOf(signerAddr);
      if (balance.isZero()) {
        console.log(`${chainName}: no ezETH, skipping.`);
        continue;
      }

      // Sanity-check the router wiring on-chain before routing funds through it.
      const wrappedToken: string = await router.wrappedToken();
      assert(
        wrappedToken.toLowerCase() === l2TokenAddr.toLowerCase(),
        `Router ${routerAddr} wraps ${wrappedToken}, not ezETH ${l2TokenAddr}`
      );
      const enrollmentReader = new Contract(
        routerAddr,
        ["function routers(uint32) external view returns (bytes32)"],
        provider
      );
      const enrolledL1Router: string = await enrollmentReader.routers(destinationDomain);
      assert(
        enrolledL1Router.toLowerCase() === ethers.utils.hexZeroPad(l1Router, 32).toLowerCase(),
        `Router ${routerAddr} has ${enrolledL1Router} enrolled for domain ${destinationDomain}, expected mainnet router ${l1Router}`
      );

      const fee: BigNumber = await router.quoteGasPayment(destinationDomain);
      const feeCap = HYPERLANE_FEE_CAP_OVERRIDES[chainId] ?? HYPERLANE_DEFAULT_FEE_CAP;
      assert(
        fee.lte(feeCap),
        `Hyperlane fee ${ethers.utils.formatEther(fee)} exceeds cap ${ethers.utils.formatEther(feeCap)}`
      );

      const allowance: BigNumber = await token.allowance(signerAddr, routerAddr);
      const needsApproval = allowance.lt(balance);

      const nativeSymbol = getNativeTokenSymbol(chainId);
      const [nativeBalance, gasPrice] = await Promise.all([provider.getBalance(signerAddr), provider.getGasPrice()]);
      const nativeNeeded = fee.add(gasPrice.mul(GAS_UNITS_BUFFER));
      const gasShortfall = nativeBalance.lt(nativeNeeded)
        ? `have ${ethers.utils.formatEther(nativeBalance)} ${nativeSymbol}, need about ${ethers.utils.formatEther(
            nativeNeeded
          )} ${nativeSymbol} (fee + gas)`
        : undefined;

      console.log(`${chainName}:`);
      console.log(`  balance:  ${formatter(balance.toString())} ezETH`);
      console.log(`  router:   ${routerAddr}`);
      console.log(`  fee:      ${ethers.utils.formatEther(fee)} ${nativeSymbol}`);
      console.log(`  approval: ${needsApproval ? "needed" : "already in place"}`);
      if (isDefined(gasShortfall)) {
        console.log(`  ⛔ insufficient native balance: ${gasShortfall}. Top up and re-run.`);
      }

      plans.push({ chainId, chainName, token, router, balance, fee, needsApproval, gasShortfall });
    } catch (error) {
      console.log(`${chainName}: skipped — ${(error as Error).message}`);
    }
  }

  const sendable = plans.filter((plan) => !isDefined(plan.gasShortfall));
  if (plans.length === 0) {
    console.log("\nNothing to evacuate.");
    return;
  }

  const total = plans.reduce((acc, plan) => acc.add(plan.balance), bnZero);
  console.log(`\nTotal to evacuate: ${formatter(total.toString())} ezETH -> ${recipient} on Mainnet`);

  if (!sendTransactions) {
    console.log("\nDry run — transaction plan:");
    for (const plan of plans) {
      console.log(`\n  ${plan.chainName} -> router ${plan.router.address}:`);
      if (plan.needsApproval) {
        console.log(
          `  approve:        ${plan.token.interface.encodeFunctionData("approve", [plan.router.address, plan.balance])}`
        );
      }
      console.log(
        `  transferRemote: ${plan.router.interface.encodeFunctionData("transferRemote", [
          destinationDomain,
          recipientBytes32,
          plan.balance,
        ])}`
      );
      console.log(`  value:          ${plan.fee.toString()} wei`);
    }
    console.log("\n💡 To execute, re-run with --sendTx");
    return;
  }

  if (sendable.length === 0) {
    console.log("\nNo chain is executable — top up native balances and re-run.");
    return;
  }
  if (
    !(await askYesNoQuestion(
      `\n⚠️  Execute ${sendable.length} evacuation(s) (${sendable.map((plan) => plan.chainName).join(", ")})?`
    ))
  ) {
    console.log("Cancelled.");
    return;
  }

  for (const plan of sendable) {
    // Re-read balance and re-quote the fee at send time; both can drift after the scan.
    const liveBalance: BigNumber = await plan.token.balanceOf(signerAddr);
    if (liveBalance.isZero()) {
      console.log(`${plan.chainName}: balance is now zero, skipping.`);
      continue;
    }
    if (plan.needsApproval) {
      console.log(`${plan.chainName}: approving...`);
      const approveTx = await plan.token.approve(plan.router.address, liveBalance);
      await approveTx.wait();
    }
    const fee: BigNumber = await plan.router.quoteGasPayment(destinationDomain);
    console.log(`${plan.chainName}: sending transferRemote...`);
    const tx = await plan.router.transferRemote(destinationDomain, recipientBytes32, liveBalance, { value: fee });
    const receipt = await tx.wait();
    console.log(`${plan.chainName}: ✅ ${blockExplorerLink(receipt.transactionHash, plan.chainId)}`);
  }

  console.log("\nAll submitted. Hyperlane delivery to mainnet usually lands within a few minutes.");
  console.log(`Verify mainnet ezETH (${L1_EZETH}) balance of ${recipient} once messages are processed.`);
}

if (require.main === module) {
  run()
    .then(() => {
      // eslint-disable-next-line no-process-exit
      process.exit(0);
    })
    .catch((error) => {
      console.error("❌ Process exited with error:", error.message);
      if (error.stack) {
        console.error(error.stack);
      }
      // eslint-disable-next-line no-process-exit
      process.exit(1);
    });
}

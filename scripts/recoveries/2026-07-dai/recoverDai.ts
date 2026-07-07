/* eslint-disable no-console */
// Recovers residual DAI left on L2 SpokePools after the DAI wind-down (see README.md).
//
// Deposits DAI on Ethereum with the destination set to the target spoke, then
// immediately requests a slow fill on the destination. The slow fill is paid
// out of the destination SpokePool's stranded DAI balance; the deposited DAI
// is swept to the HubPool via the next mainnet pool-rebalance leaf.
//
// Run from the repo root:
//   yarn tsx scripts/recoveries/2026-07-dai/recoverDai.ts \
//     --to <destinationChainId> [--amount <DAI>|max] [--recipient <address>] \
//     [--wallet secret|mnemonic|privateKey] [--dryRun]
import assert from "assert";
import minimist from "minimist";
import { config } from "dotenv";
import { Contract, ethers, Signer } from "ethers";
import { CHAIN_IDs } from "@across-protocol/constants";
import { ExpandedERC20__factory as ERC20 } from "@across-protocol/sdk/typechain";
import {
  BigNumber,
  blockExplorerLink,
  disconnectRedisClients,
  exit,
  getNetworkName,
  getProvider,
  getSigner,
  isDefined,
  toAddressType,
} from "../../../src/utils";
import * as utils from "../../utils";

const { NODE_SUCCESS, NODE_INPUT_ERR, NODE_APP_ERR } = utils;
const { formatUnits, parseUnits } = ethers.utils;
const { AddressZero, HashZero } = ethers.constants;

const HUB_CHAIN_ID = CHAIN_IDs.MAINNET;
const DAI_DECIMALS = 18;
const DAI_L1 = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const DEFAULT_TRANCHE = "2000"; // DAI

// L2 DAI addresses exactly as registered in the HubPool PoolRebalanceRoutes
// (SetPoolRebalanceRoute events, all still live on-chain). Hardcoded for
// self-containment; matches TOKEN_SYMBOLS_MAP.DAI. Blast (81457, USDB) is
// deliberately absent: it still has organic flow and is swept regularly.
const L2_DAI: { [chainId: number]: string } = {
  [CHAIN_IDs.OPTIMISM]: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
  [CHAIN_IDs.POLYGON]: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  [CHAIN_IDs.ZK_SYNC]: "0x4B9eb6c0b6ea15176BBF62841C6B2A8a398cb656",
  [CHAIN_IDs.BASE]: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  [CHAIN_IDs.ARBITRUM]: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
  [CHAIN_IDs.LINEA]: "0x4AF15ec2A0BD43Db75dd04E62FAA3B8EF36b00d5",
};

// Portion of a spoke's on-chain DAI balance that is absent from executed
// pool-rebalance running balances. Slow fills beyond the *tracked* balance
// flip the running balance positive and make the Hub send DAI back to the
// spoke, so this portion is excluded here and must instead be recovered via a
// relayer-refund-root admin recovery (see ../2026-06-accounting).
//
// zkSync: the DAI running balance was implicitly reset from -70,005.07 to 0
// between the bundles executed 2026-03-12 (0x56c621c44bc153cfdc7226335bba02f6
// 5955e66da9f4dad52e9fb5b52852de5c) and 2026-04-20 (0x29fd983ad6fab2d0b8af00da
// c251f6e4e67d785f228840644bfc0c9e7b62ea5b) with no TokensBridged sweep
// (pre-SDK-4.4.0 running-balance lookback bug).
const UNTRACKED: { [chainId: number]: BigNumber } = {
  [CHAIN_IDs.ZK_SYNC]: parseUnits("70005.07", DAI_DECIMALS),
};

const fmt = (amount: BigNumber): string => ethers.utils.commify(formatUnits(amount, DAI_DECIMALS));

async function recover(args: Record<string, number | string | boolean>, signer: Signer): Promise<boolean> {
  const toChainId = Number(args.to);
  const dryRun = Boolean(args.dryRun);

  if (!isDefined(L2_DAI[toChainId])) {
    console.log(`Unsupported destination chain ${args.to}. Supported: ${Object.keys(L2_DAI).join(", ")}.`);
    return false;
  }

  const [hubProvider, destProvider] = await Promise.all([getProvider(HUB_CHAIN_ID), getProvider(toChainId)]);
  const hubSigner = signer.connect(hubProvider);
  const destSigner = signer.connect(destProvider);
  const [hubSpoke, destSpoke] = await Promise.all([
    utils.getSpokePoolContract(HUB_CHAIN_ID),
    utils.getSpokePoolContract(toChainId),
  ]);

  const depositor = await signer.getAddress();
  const recipient = String(args.recipient ?? depositor);
  if (!ethers.utils.isAddress(recipient) || recipient === AddressZero) {
    console.log(`Invalid recipient address (${recipient}).`);
    return false;
  }

  // Ground truth: how much DAI is physically on the destination spoke, and how
  // much of it is safe to recover via slow fills.
  const l2Dai = new Contract(L2_DAI[toChainId], ERC20.abi, destProvider);
  const spokeBalance: BigNumber = await l2Dai.balanceOf(destSpoke.address);
  const untracked = UNTRACKED[toChainId] ?? ethers.constants.Zero;
  const recoverable = spokeBalance.sub(untracked);
  if (recoverable.lte(0)) {
    console.log(
      `Nothing recoverable on ${getNetworkName(toChainId)}:` +
        ` spoke balance ${fmt(spokeBalance)} DAI <= untracked ${fmt(untracked)} DAI.`
    );
    return false;
  }

  const amount = args.amount === "max" ? recoverable : parseUnits(String(args.amount), DAI_DECIMALS);
  if (amount.lte(0) || amount.gt(recoverable)) {
    console.log(
      `Requested amount ${fmt(amount)} DAI is outside the recoverable range` +
        ` (spoke balance ${fmt(spokeBalance)} - untracked ${fmt(untracked)} = ${fmt(recoverable)} DAI).`
    );
    return false;
  }

  // quoteTimestamp must be current per the origin SpokePool; fillDeadline is
  // capped at quoteTimestamp + fillDeadlineBuffer (6h on mainnet). Use the max:
  // the request -> propose -> liveness -> relay -> execute pipeline needs it.
  const [quoteTimestamp, fillDeadlineBuffer] = await Promise.all([
    hubSpoke.connect(hubProvider).getCurrentTime(),
    hubSpoke.connect(hubProvider).fillDeadlineBuffer(),
  ]);
  const fillDeadline = Number(quoteTimestamp) + Number(fillDeadlineBuffer);

  const l1Dai = new Contract(DAI_L1, ERC20.abi, hubSigner);
  const [balance, allowance] = await Promise.all([
    l1Dai.balanceOf(depositor),
    l1Dai.allowance(depositor, hubSpoke.address),
  ]);

  const plan = {
    destination: `${getNetworkName(toChainId)} (${toChainId})`,
    spokePool: destSpoke.address,
    spokeBalance: `${fmt(spokeBalance)} DAI`,
    untracked: `${fmt(untracked)} DAI`,
    recoverable: `${fmt(recoverable)} DAI`,
    amount: `${fmt(amount)} DAI`,
    depositor,
    recipient,
    outputToken: L2_DAI[toChainId],
    quoteTimestamp: `${quoteTimestamp}`,
    fillDeadline: `${fillDeadline} (${new Date(fillDeadline * 1000).toUTCString()})`,
  };
  const padLeft = Object.keys(plan).reduce((acc, cur) => (cur.length > acc ? cur.length : acc), 0);
  console.log(
    `\nDAI recovery via Ethereum deposit + ${getNetworkName(toChainId)} slow fill:\n` +
      Object.entries(plan)
        .map(([k, v]) => `\t${k.padEnd(padLeft)} : ${v}`)
        .join("\n") +
      "\n"
  );

  const depositArgs = [
    toAddressType(depositor, HUB_CHAIN_ID).toBytes32(),
    toAddressType(recipient, toChainId).toBytes32(),
    toAddressType(DAI_L1, HUB_CHAIN_ID).toBytes32(),
    toAddressType(L2_DAI[toChainId], toChainId).toBytes32(),
    amount, // inputAmount
    amount, // outputAmount: no relayer fee, so fast fills are unprofitable and the slow fill drains the spoke.
    toChainId,
    HashZero, // exclusiveRelayer
    quoteTimestamp,
    fillDeadline,
    0, // exclusivityParameter: slow fill can be requested immediately.
    "0x", // message: must be empty for slow-fill eligibility.
  ];

  if (dryRun) {
    const populated = await hubSpoke.connect(hubProvider).populateTransaction.deposit(...depositArgs);
    console.log(`Dry run: deposit calldata for ${getNetworkName(HUB_CHAIN_ID)} SpokePool ${hubSpoke.address}:`);
    console.log(populated.data);
    console.log("\nDry run: no transactions sent. requestSlowFill relayData is derived from the FundsDeposited event.");
    return true;
  }

  if (amount.gt(balance)) {
    console.log(`Insufficient mainnet DAI balance for deposit (${fmt(balance)} < ${fmt(amount)}).`);
    return false;
  }

  if (!(await utils.askYesNoQuestion("Proceed with deposit + slow-fill request?"))) {
    return false;
  }

  if (amount.gt(allowance)) {
    console.log(`Approving SpokePool for ${fmt(amount)} DAI...`);
    const approval = await l1Dai.approve(hubSpoke.address, amount);
    await approval.wait();
    console.log(`Approval complete: ${approval.hash}.`);
  }

  const depositTxn = await hubSpoke.connect(hubSigner).deposit(...depositArgs);
  console.log(`Deposit submitted: ${blockExplorerLink(depositTxn.hash, HUB_CHAIN_ID)}. Waiting...`);
  const depositReceipt = await depositTxn.wait();

  const fundsDeposited = hubSpoke.interface.getEventTopic("FundsDeposited");
  const depositLog = depositReceipt.logs.find(
    ({ address, topics }: ethers.providers.Log) => address === hubSpoke.address && topics[0] === fundsDeposited
  );
  assert(isDefined(depositLog), "FundsDeposited event not found in deposit receipt");
  const deposit = hubSpoke.interface.parseLog(depositLog).args;
  console.log(`Deposit ${deposit.depositId} confirmed in block ${depositReceipt.blockNumber}.`);

  // relayData must match the FundsDeposited event exactly, so build it from the event.
  const relayData = {
    depositor: deposit.depositor,
    recipient: deposit.recipient,
    exclusiveRelayer: deposit.exclusiveRelayer,
    inputToken: deposit.inputToken,
    outputToken: deposit.outputToken,
    inputAmount: deposit.inputAmount,
    outputAmount: deposit.outputAmount,
    originChainId: HUB_CHAIN_ID,
    depositId: deposit.depositId,
    fillDeadline: deposit.fillDeadline,
    exclusivityDeadline: deposit.exclusivityDeadline,
    message: deposit.message,
  };

  const requestTxn = await destSpoke.connect(destSigner).requestSlowFill(relayData);
  console.log(`Slow-fill request submitted: ${blockExplorerLink(requestTxn.hash, toChainId)}. Waiting...`);
  const requestReceipt = await requestTxn.wait();
  console.log(`Slow-fill request confirmed in block ${requestReceipt.blockNumber}.`);

  console.log(
    "\nDone. The request must be included in a proposed bundle, survive liveness and execute" +
      ` on ${getNetworkName(toChainId)} before ${new Date(fillDeadline * 1000).toUTCString()}.` +
      "\nIf it expires, the deposit is refunded to the depositor on Ethereum in a subsequent bundle — re-run then."
  );

  return true;
}

function usage(badInput?: string): boolean {
  const usageStr =
    (badInput ? `\nUnrecognized input: "${badInput}".\n\n` : "") +
    `
    Usage:
    \tyarn tsx ./scripts/recoveries/2026-07-dai/recoverDai.ts
    \t\t--to <destinationChainId (${Object.keys(L2_DAI).join("|")})>
    \t\t[--amount <DAI amount|max>] (default ${DEFAULT_TRANCHE})
    \t\t[--recipient <address>] (default: depositor)
    \t\t[--wallet secret|mnemonic|privateKey] (default secret)
    \t\t[--dryRun]
  `.slice(1);
  console.log(usageStr);

  return !isDefined(badInput);
}

async function run(argv: string[]): Promise<number> {
  const opts = {
    string: ["to", "amount", "recipient", "wallet"],
    boolean: ["dryRun"],
    default: { wallet: "secret", amount: DEFAULT_TRANCHE, dryRun: false },
    unknown: usage,
  };
  const args = minimist(argv, opts);

  config();
  if (!isDefined(args.to)) {
    return usage() ? NODE_SUCCESS : NODE_INPUT_ERR;
  }

  let signer: Signer;
  try {
    const keyType = args.dryRun ? "void" : args.wallet;
    signer = await getSigner({ keyType, cleanEnv: true });
  } catch {
    return usage(args.wallet) ? NODE_SUCCESS : NODE_INPUT_ERR;
  }

  return (await recover(args, signer)) ? NODE_SUCCESS : NODE_APP_ERR;
}

if (require.main === module) {
  run(process.argv.slice(2))
    .then(async (result) => {
      process.exitCode = result;
    })
    .catch(async (error) => {
      console.error("Process exited with", error);
      process.exitCode = NODE_APP_ERR;
    })
    .finally(async () => {
      await disconnectRedisClients();
      exit(Number(process.exitCode));
    });
}

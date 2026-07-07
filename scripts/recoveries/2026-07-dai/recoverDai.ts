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
//     [--wallet secret|mnemonic|privateKey] [--dryRun [--depositor <address>]]
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
  paginatedEventQuery,
  sortEventsDescending,
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

// Pool-rebalance leaves only carry (chain, token) pairs with activity in the
// bundle window, so a chain's *tracked* DAI running balance is the value in
// the most recent executed leaf that carries DAI (per README.md, within the
// last month for every supported chain; the recovery's own activity keeps it
// fresh thereafter). Scanned backwards from the chain head in windows.
const LEAF_SCAN_WINDOW = 50_000; // Blocks per backwards scan step (~7 days on mainnet).
const LEAF_SCAN_DEPTH = 16; // Give up after ~16 windows (~4 months) with no executed DAI leaf.

const fmt = (amount: BigNumber): string => ethers.utils.commify(formatUnits(amount, DAI_DECIMALS));

// Returns the DAI running balance from the most recent executed pool-rebalance
// leaf for chainId, or undefined if none is found within the scan depth.
async function getTrackedRunningBalance(hubPool: Contract, chainId: number): Promise<BigNumber | undefined> {
  const filter = hubPool.filters.RootBundleExecuted(null, null, chainId);
  let to = await hubPool.provider.getBlockNumber();

  for (let i = 0; i < LEAF_SCAN_DEPTH; ++i, to -= LEAF_SCAN_WINDOW) {
    const from = Math.max(to - LEAF_SCAN_WINDOW + 1, 0);
    const leaves = await paginatedEventQuery(hubPool, filter, { from, to, maxLookBack: 10_000 });
    for (const { args } of sortEventsDescending(leaves)) {
      const idx = args.l1Tokens.findIndex((token: string) => token.toLowerCase() === DAI_L1.toLowerCase());
      if (idx !== -1) {
        return args.runningBalances[idx]; // int256: negative => spoke surplus owed to the HubPool.
      }
    }
  }

  return undefined;
}

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

  // The depositor receives the mainnet refund if the slow fill expires, so in
  // live mode it must be the connected wallet. Dry runs use a VoidSigner that
  // defaults to address(0); --depositor substitutes a real address so the
  // printed calldata encodes usable depositor/recipient values.
  const signerAddr = await signer.getAddress();
  let depositor: string, recipient: string;
  try {
    depositor = ethers.utils.getAddress(String(args.depositor ?? signerAddr));
    recipient = ethers.utils.getAddress(String(args.recipient ?? depositor));
  } catch {
    console.log(`Invalid depositor (${args.depositor ?? signerAddr}) or recipient (${args.recipient}) address.`);
    return false;
  }
  if (!dryRun && depositor !== signerAddr) {
    console.log(`Depositor ${depositor} must be the connected wallet (${signerAddr}).`);
    return false;
  }
  const resolvedAddrs = depositor !== AddressZero && recipient !== AddressZero;
  if (!resolvedAddrs && !dryRun) {
    console.log(`Invalid depositor/recipient address (${depositor}/${recipient}).`);
    return false;
  }

  // Ground truth: how much DAI is physically on the destination spoke, and how
  // much of it executed pool-rebalance running balances track. Slow fills
  // beyond the tracked surplus flip the running balance positive and make the
  // Hub send DAI back to the spoke (zkSync's balance is largely untracked —
  // see README.md), so recovery is capped by both.
  const hubPool = await utils.getContract(HUB_CHAIN_ID, "HubPool");
  const l2Dai = new Contract(L2_DAI[toChainId], ERC20.abi, destProvider);
  const [spokeBalance, runningBalance] = await Promise.all([
    l2Dai.balanceOf(destSpoke.address) as Promise<BigNumber>,
    getTrackedRunningBalance(hubPool, toChainId),
  ]);
  if (!isDefined(runningBalance)) {
    console.log(
      `No executed pool-rebalance leaf carrying DAI found for ${getNetworkName(toChainId)} within the last` +
        ` ~${LEAF_SCAN_WINDOW * LEAF_SCAN_DEPTH} mainnet blocks; cannot establish the tracked running balance.`
    );
    return false;
  }

  const trackedSurplus = runningBalance.isNegative() ? runningBalance.mul(-1) : ethers.constants.Zero;
  const recoverable = spokeBalance.lt(trackedSurplus) ? spokeBalance : trackedSurplus;
  if (recoverable.lte(0)) {
    console.log(
      `Nothing recoverable on ${getNetworkName(toChainId)}: spoke balance ${fmt(spokeBalance)} DAI,` +
        ` tracked running balance ${fmt(runningBalance)} DAI.`
    );
    return false;
  }

  const amount = args.amount === "max" ? recoverable : parseUnits(String(args.amount), DAI_DECIMALS);
  if (amount.lte(0) || amount.gt(recoverable)) {
    console.log(
      `Requested amount ${fmt(amount)} DAI is outside the recoverable range` +
        ` (min(spoke balance ${fmt(spokeBalance)}, tracked surplus ${fmt(trackedSurplus)}) = ${fmt(recoverable)} DAI).`
    );
    return false;
  }

  // quoteTimestamp must be current per the origin SpokePool; fillDeadline is
  // capped at quoteTimestamp + fillDeadlineBuffer (6h on mainnet). Use the max:
  // the request -> propose -> liveness -> relay -> execute pipeline needs it.
  // Both are refreshed just before the live deposit; the plan values are indicative.
  const getQuoteTimestamp = async (): Promise<number> => Number(await hubSpoke.connect(hubProvider).getCurrentTime());
  const fillDeadlineBuffer = Number(await hubSpoke.connect(hubProvider).fillDeadlineBuffer());
  let quoteTimestamp = await getQuoteTimestamp();
  let fillDeadline = quoteTimestamp + fillDeadlineBuffer;

  const l1Dai = new Contract(DAI_L1, ERC20.abi, hubSigner);
  const [balance, allowance] = await Promise.all([
    l1Dai.balanceOf(depositor),
    l1Dai.allowance(depositor, hubSpoke.address),
  ]);

  const plan = {
    destination: `${getNetworkName(toChainId)} (${toChainId})`,
    spokePool: destSpoke.address,
    spokeBalance: `${fmt(spokeBalance)} DAI`,
    trackedRunningBalance: `${fmt(runningBalance)} DAI`,
    recoverable: `${fmt(recoverable)} DAI`,
    amount: `${fmt(amount)} DAI`,
    depositor: depositor === AddressZero ? "(unset — pass --depositor)" : depositor,
    recipient: recipient === AddressZero ? "(unset — pass --depositor or --recipient)" : recipient,
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

  // Reads quoteTimestamp/fillDeadline at call time so the live path can refresh them.
  const makeDepositArgs = () => [
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
    if (!resolvedAddrs) {
      console.log("Dry run: pass --depositor (and optionally --recipient) to also generate the deposit calldata.");
      return true;
    }
    const populated = await hubSpoke.connect(hubProvider).populateTransaction.deposit(...makeDepositArgs());
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

  // Refresh the quote after the prompt/approval delays: the SpokePool rejects
  // quoteTimestamps older than depositQuoteTimeBuffer, which would revert the
  // deposit after spending gas.
  quoteTimestamp = await getQuoteTimestamp();
  fillDeadline = quoteTimestamp + fillDeadlineBuffer;

  const depositTxn = await hubSpoke.connect(hubSigner).deposit(...makeDepositArgs());
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
    \t\t[--dryRun] (no key needed)
    \t\t[--depositor <address>] (dry-run only: substitute for the unlocked wallet)
  `.slice(1);
  console.log(usageStr);

  return !isDefined(badInput);
}

async function run(argv: string[]): Promise<number> {
  const opts = {
    string: ["to", "amount", "recipient", "depositor", "wallet"],
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

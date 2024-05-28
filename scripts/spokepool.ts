import axios, { isAxiosError } from "axios";
import minimist from "minimist";
import { groupBy } from "lodash";
import { config } from "dotenv";
import { Contract, ethers, Signer } from "ethers";
import { LogDescription } from "@ethersproject/abi";
import { constants as sdkConsts, utils as sdkUtils } from "@across-protocol/sdk-v2";
import { ExpandedERC20__factory as ERC20 } from "@across-protocol/contracts-v2";
import {
  BigNumber,
  formatFeePct,
  getDeploymentBlockNumber,
  getNetworkName,
  getSigner,
  isDefined,
  resolveTokenSymbols,
  toBN,
} from "../src/utils";
import * as utils from "./utils";

type Log = ethers.providers.Log;

type relayerFeeQuery = {
  originChainId: number;
  destinationChainId: number;
  token: string;
  amount: string;
  recipientAddress?: string;
  message?: string;
  skipAmountLimit?: string;
  timestamp?: number;
};

const { ACROSS_API_HOST = "across.to" } = process.env;

const { NODE_SUCCESS, NODE_INPUT_ERR, NODE_APP_ERR } = utils;
const { fixedPointAdjustment: fixedPoint } = sdkUtils;
const { MaxUint256, Zero } = ethers.constants;
const { isAddress } = ethers.utils;

function printDeposit(log: LogDescription): void {
  const { originChainId, originToken } = log.args;
  const eventArgs = Object.keys(log.args).filter((key) => isNaN(Number(key)));
  const padLeft = eventArgs.reduce((acc, cur) => (cur.length > acc ? cur.length : acc), 0);

  const fields = {
    tokenSymbol: resolveTokenSymbols([originToken], originChainId)[0],
    ...Object.fromEntries(eventArgs.map((key) => [key, log.args[key]])),
  };
  console.log(
    `Deposit # ${log.args.depositId} on ${getNetworkName(originChainId)}:\n` +
      Object.entries(fields)
        .map(([k, v]) => `\t${k.padEnd(padLeft)} : ${v}`)
        .join("\n") +
      "\n"
  );
}

function printFill(log: LogDescription): void {
  const { originChainId, destinationChainId, destinationToken, amount, totalFilledAmount } = log.args;
  const eventArgs = Object.keys(log.args).filter((key) => isNaN(Number(key)));
  const padLeft = eventArgs.reduce((acc, cur) => (cur.length > acc ? cur.length : acc), 0);

  const fields = {
    tokenSymbol: resolveTokenSymbols([destinationToken], destinationChainId)[0],
    totalFilledPct: `${totalFilledAmount.mul(100).div(amount)} %`,
    ...Object.fromEntries(eventArgs.map((key) => [key, log.args[key]])),
  };
  console.log(
    `Fill for ${getNetworkName(originChainId)} deposit # ${log.args.depositId}:\n` +
      Object.entries(fields)
        .map(([k, v]) => `\t${k.padEnd(padLeft)} : ${v}`)
        .join("\n") +
      "\n"
  );
}

async function getRelayerFeePct(params: relayerFeeQuery, timeout = 5000): Promise<BigNumber> {
  const quoteData = await getSuggestedFees(params, timeout);
  if (!isDefined(quoteData["relayFeePct"])) {
    throw new Error("relayFeePct missing from suggested-fees response");
  }
  return toBN(quoteData["relayFeePct"]);
}

async function getLpFeePct(params: relayerFeeQuery, timeout = 5000): Promise<BigNumber> {
  const quoteData = await getSuggestedFees(params, timeout);
  if (!isDefined(quoteData?.["lpFee"]?.["pct"])) {
    throw new Error("lpFeePct missing from suggested-fees response");
  }
  return toBN(quoteData["lpFee"]["pct"]);
}

async function getSuggestedFees(params: relayerFeeQuery, timeout: number) {
  const path = "api/suggested-fees";
  const url = `https://${ACROSS_API_HOST}/${path}`;

  try {
    const quote = await axios.get(url, { timeout, params });
    return quote.data;
  } catch (err) {
    if (isAxiosError(err) && err.response.status >= 400) {
      throw new Error(`Failed to get quote for deposit (${err.response.data})`);
    }
    throw err;
  }
}

async function getRelayerQuote(
  fromChainId: number,
  toChainId: number,
  token: utils.ERC20,
  amount: BigNumber,
  recipient?: string,
  message?: string
): Promise<BigNumber> {
  const tokenFormatter = sdkUtils.createFormatFunction(2, 4, false, token.decimals);
  let relayerFeePct = Zero;
  let quoteAccepted = false;
  do {
    relayerFeePct = await getRelayerFeePct({
      token: token.address,
      originChainId: fromChainId,
      destinationChainId: toChainId,
      amount: amount.toString(),
      recipientAddress: recipient,
      message,
    });

    const feeAmount = amount.mul(relayerFeePct).div(fixedPoint);
    const quote =
      `Relayer fee quote for ${tokenFormatter(amount)} ${token.symbol} ${fromChainId} -> ${toChainId}:` +
      ` ${formatFeePct(relayerFeePct)} % (${tokenFormatter(feeAmount)} ${token.symbol})`;
    quoteAccepted = await utils.askYesNoQuestion(quote);
  } while (!quoteAccepted);

  return relayerFeePct;
}

async function deposit(args: Record<string, number | string>, signer: Signer): Promise<boolean> {
  const depositor = await signer.getAddress();
  const [fromChainId, toChainId, baseAmount] = [Number(args.from), Number(args.to), Number(args.amount)];
  const recipient = (args.recipient as string) ?? depositor;
  const message = (args.message as string) ?? sdkConsts.EMPTY_MESSAGE;

  if (!utils.validateChainIds([fromChainId, toChainId])) {
    console.log(`Invalid set of chain IDs (${fromChainId}, ${toChainId}).`);
    return false;
  }
  const network = getNetworkName(fromChainId);

  if (!isAddress(recipient)) {
    console.log(`Invalid recipient address (${recipient}).`);
    return false;
  }

  const token = utils.resolveToken(args.token as string, fromChainId);
  const tokenSymbol = token.symbol.toUpperCase();
  const amount = ethers.utils.parseUnits(baseAmount.toString(), args.decimals ? 0 : token.decimals);

  const provider = new ethers.providers.StaticJsonRpcProvider(utils.getProviderUrl(fromChainId));
  signer = signer.connect(provider);
  const spokePool = (await utils.getSpokePoolContract(fromChainId)).connect(signer);

  const erc20 = new Contract(token.address, ERC20.abi, signer);
  const allowance = await erc20.allowance(depositor, spokePool.address);
  if (amount.gt(allowance)) {
    const approvalAmount = amount.mul(5);
    const approval = await erc20.approve(spokePool.address, approvalAmount);
    console.log(`Approving SpokePool for ${approvalAmount} ${tokenSymbol}: ${approval.hash}.`);
    await approval.wait();
    console.log("Approval complete...");
  }
  const maxCount = MaxUint256;
  const relayerFeePct = isDefined(args.relayerFeePct)
    ? toBN(args.relayerFeePct)
    : await getRelayerQuote(fromChainId, toChainId, token, amount, recipient, message);
  const quoteTimestamp = await spokePool.getCurrentTime();

  const deposit = await spokePool.deposit(
    recipient,
    token.address,
    amount,
    toChainId,
    relayerFeePct,
    quoteTimestamp,
    message,
    maxCount
  );
  const { hash: transactionHash } = deposit;
  console.log(`Submitting ${tokenSymbol} deposit on ${network}: ${transactionHash}.`);
  const receipt = (await deposit.wait()) as ethers.providers.TransactionReceipt;

  receipt.logs
    .filter((log) => log.address === spokePool.address)
    .forEach((log) => printDeposit(spokePool.interface.parseLog(log)));

  return true;
}

// Just a convenience constant to help with printing the fill that's about to be sent.
const FILL_ARG_NAMES = [
  "depositor",
  "recipient",
  "destinationToken",
  "amount",
  "maxTokensToSend",
  "repaymentChainId",
  "originChainId",
  "realizedLpFeePct",
  "relayerFeePct",
  "depositId",
  "message",
  "maxCount",
];

async function fillDeposit(args: Record<string, number | string | boolean>, signer: Signer): Promise<boolean> {
  const { txnHash, depositId: depositIdArg, execute } = args;
  const chainId = Number(args.chainId);

  if (txnHash === undefined || typeof txnHash !== "string" || txnHash.length != 66 || !txnHash.startsWith("0x")) {
    throw new Error(`Missing or malformed transaction hash: ${txnHash}`);
  }

  const originProvider = new ethers.providers.StaticJsonRpcProvider(utils.getProviderUrl(chainId));
  const originSpokePool = await utils.getSpokePoolContract(chainId);
  const spokePools: { [chainId: number]: Contract } = {};

  const txn = await originProvider.getTransactionReceipt(txnHash);

  const fundsDeposited = originSpokePool.interface.getEventTopic("FundsDeposited");
  const depositLogs = txn.logs
    .filter(({ topics, address }) => topics[0] === fundsDeposited && address === originSpokePool.address)
    .map((log) => originSpokePool.interface.parseLog(log));

  if (depositLogs.length === 0) {
    throw new Error("No deposits found in txn");
  }

  let deposit: ethers.utils.LogDescription;
  if (depositIdArg === undefined) {
    if (depositLogs.length > 1) {
      throw new Error("Multiple deposits in transaction. Must provide depositId");
    }

    deposit = depositLogs[0];
  } else {
    const foundDeposit = depositLogs.find((log) => log.args["depositId"] === depositId);
    if (foundDeposit === undefined) {
      throw new Error(`No deposit found for id ${args["depositId"]}`);
    }
    deposit = foundDeposit;
  }

  const { depositId, relayerFeePct, originToken, quoteTimestamp, amount, depositor, recipient, message } = deposit.args;
  const originChainId = Number(deposit.args.originChainId.toString());
  const destinationChainId = Number(deposit.args.destinationChainId.toString());
  const destSpokePool = spokePools[destinationChainId] ?? (await utils.getSpokePoolContract(destinationChainId));

  const originTokenInfo = utils.resolveToken(originToken, originChainId);
  const destinationTokenInfo = utils.resolveToken(originTokenInfo.symbol, destinationChainId);
  const destinationToken = destinationTokenInfo.address;
  const realizedLpFeePct = await getLpFeePct({
    originChainId,
    destinationChainId,
    token: originToken,
    amount: amount.toString(),
    skipAmountLimit: "true",
    timestamp: Number(quoteTimestamp.toString()),
  });

  const fill = [
    depositor, // depositor
    recipient, // recipient
    destinationToken, // destinationToken
    amount, // amount
    amount, // maxTokensToSend
    destinationChainId, // repaymentChainId
    originChainId, // originChainId
    realizedLpFeePct, // realizedLpFeePct
    relayerFeePct, // relayerFeePct
    depositId, // depositId
    message, // message
    MaxUint256.toString(), // maxCount
  ];

  const txnToSend = await destSpokePool.populateTransaction.fillRelay(...fill);
  console.group("Fill Arguments");
  fill.forEach((e, i) => console.log(`${FILL_ARG_NAMES[i]}: ${e.toString()}`));
  console.groupEnd();

  console.group("Fill Txn Info");
  console.log(`to: ${txnToSend.to}`);
  console.log(`value: ${txnToSend.value || "0"}`);
  console.log(`data: ${txnToSend.data}`);
  console.groupEnd();

  if (execute) {
    const question = "Are you sure you want to send this fill?";
    const questionAccepted = await utils.askYesNoQuestion(question);
    if (!questionAccepted) {
      return true;
    }

    const sender = await signer.getAddress();
    const destProvider = new ethers.providers.StaticJsonRpcProvider(utils.getProviderUrl(destinationChainId));
    const destSigner = signer.connect(destProvider);

    const erc20 = new Contract(destinationToken, ERC20.abi, destSigner);
    const allowance = await erc20.allowance(sender, destSpokePool.address);
    if (amount.gt(allowance)) {
      const approvalAmount = amount.mul(5);
      const approval = await erc20.approve(destSpokePool.address, approvalAmount);
      console.log(`Approving SpokePool for ${approvalAmount} ${originTokenInfo.symbol}: ${approval.hash}.`);
      await approval.wait();
      console.log("Approval complete...");
    }

    const fillTxn = await destSigner.sendTransaction(txnToSend);
    const receipt = await fillTxn.wait();
    console.log(`Tx hash: ${receipt.transactionHash}`);
  }

  return true;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function dumpConfig(args: Record<string, number | string>, _signer: Signer): Promise<boolean> {
  const chainId = Number(args.chainId);
  const _spokePool = await utils.getSpokePoolContract(chainId);

  const hubChainId = utils.resolveHubChainId(chainId);
  const spokeProvider = new ethers.providers.StaticJsonRpcProvider(utils.getProviderUrl(chainId));
  const spokePool = _spokePool.connect(spokeProvider);

  const [spokePoolChainId, hubPool, crossDomainAdmin, weth, _currentTime] = await Promise.all([
    spokePool.chainId(),
    spokePool.hubPool(),
    spokePool.crossDomainAdmin(),
    spokePool.wrappedNativeToken(),
    spokePool.getCurrentTime(),
  ]);

  if (chainId !== Number(spokePoolChainId)) {
    throw new Error(`Chain ${chainId} SpokePool mismatch: ${spokePoolChainId} != ${chainId} (${spokePool.address})`);
  }

  const currentTime = `${_currentTime} (${new Date(Number(_currentTime) * 1000).toUTCString()})`;

  const fields = {
    hubChainId,
    hubPool,
    crossDomainAdmin,
    weth,
    currentTime,
  };

  // @todo: Support handlers for chain-specific configuration (i.e. address of bridge to L1).

  const padLeft = Object.keys(fields).reduce((acc, cur) => (cur.length > acc ? cur.length : acc), 0);
  console.log(
    `${getNetworkName(chainId)} SpokePool configuration:\n` +
      Object.entries(fields)
        .map(([k, v]) => `\t${k.padEnd(padLeft)} : ${v}`)
        .join("\n") +
      "\n"
  );

  return true;
}

async function _fetchDeposit(spokePool: Contract, _depositId: number | string): Promise<Log[]> {
  const depositId = parseInt(_depositId.toString());
  if (isNaN(depositId)) {
    throw new Error("No depositId specified");
  }

  const { chainId } = await spokePool.provider.getNetwork();
  const deploymentBlockNumber = getDeploymentBlockNumber("SpokePool", chainId);
  const latestBlockNumber = await spokePool.provider.getBlockNumber();
  console.log(`Searching for depositId ${depositId} between ${deploymentBlockNumber} and ${latestBlockNumber}.`);
  const filter = spokePool.filters.FundsDeposited(null, null, null, null, depositId);

  // @note: Querying over such a large block range typically only works on top-tier providers.
  // @todo: Narrow the block range for the depositId, subject to this PR:
  //        https://github.com/across-protocol/sdk-v2/pull/476
  return await spokePool.queryFilter(filter, deploymentBlockNumber, latestBlockNumber);
}

async function _fetchTxn(spokePool: Contract, txnHash: string): Promise<{ deposits: Log[]; fills: Log[] }> {
  if (txnHash === undefined || typeof txnHash !== "string" || txnHash.length != 66 || !txnHash.startsWith("0x")) {
    throw new Error(`Missing or malformed transaction hash: ${txnHash}`);
  }

  const txn = await spokePool.provider.getTransactionReceipt(txnHash);
  const fundsDeposited = spokePool.interface.getEventTopic("FundsDeposited");
  const filledRelay = spokePool.interface.getEventTopic("FilledRelay");
  const logs = txn.logs.filter(({ address }) => address === spokePool.address);
  const { deposits = [], fills = [] } = groupBy(logs, ({ topics }) => {
    switch (topics[0]) {
      case fundsDeposited:
        return "deposits";
      case filledRelay:
        return "fills";
    }
  });

  return { deposits, fills };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function fetchTxn(args: Record<string, number | string>, _signer: Signer): Promise<boolean> {
  const { txnHash } = args;
  const chainId = Number(args.chainId);

  if (!utils.validateChainIds([chainId])) {
    console.log(`Invalid chain ID (${chainId}).`);
    return false;
  }

  const provider = new ethers.providers.StaticJsonRpcProvider(utils.getProviderUrl(chainId));
  const spokePool = (await utils.getSpokePoolContract(chainId)).connect(provider);

  let deposits: Log[] = [];
  let fills: Log[] = [];
  if (args.depositId) {
    deposits = await _fetchDeposit(spokePool, args.depositId);
  } else if (txnHash) {
    ({ deposits, fills } = await _fetchTxn(spokePool, txnHash as string));
  }

  deposits.forEach((deposit) => {
    printDeposit(spokePool.interface.parseLog(deposit));
  });

  fills.forEach((fill) => {
    printFill(spokePool.interface.parseLog(fill));
  });

  return true;
}

function usage(badInput?: string): boolean {
  let usageStr = badInput ? `\nUnrecognized input: "${badInput}".\n\n` : "";
  const walletOpts = "mnemonic|privateKey";
  const depositArgs =
    "--from <originChainId> --to <destinationChainId>" +
    " --token <tokenSymbol> --amount <amount> [--recipient <recipient>] [--decimals]";
  const dumpConfigArgs = "--chainId";
  const fetchArgs = "--chainId <chainId> [--depositId <depositId> | --txnHash <txnHash>]";
  const fillArgs = "--chainId <originChainId> --txnHash <depositHash> [--depositId <depositId>] [--execute]";

  const pad = "deposit".length;
  usageStr += `
    Usage:
    \tyarn ts-node ./scripts/spokepool --wallet <${walletOpts}> ${"deposit".padEnd(pad)} ${depositArgs}
    \tyarn ts-node ./scripts/spokepool --wallet <${walletOpts}> ${"dump".padEnd(pad)} ${dumpConfigArgs}
    \tyarn ts-node ./scripts/spokepool --wallet <${walletOpts}> ${"fetch".padEnd(pad)} ${fetchArgs}
    \tyarn ts-node ./scripts/spokepool --wallet <${walletOpts}> ${"fetch".padEnd(pad)} ${fillArgs}
  `.slice(1); // Skip leading newline
  console.log(usageStr);

  return !isDefined(badInput);
}

async function run(argv: string[]): Promise<number> {
  const configOpts = ["chainId"];
  const depositOpts = ["from", "to", "token", "amount", "recipient", "relayerFeePct", "message"];
  const fetchOpts = ["chainId", "transactionHash", "depositId"];
  const fillOpts = ["txnHash", "chainId", "depositId"];
  const fetchDepositOpts = ["chainId", "depositId"];
  const opts = {
    string: ["wallet", ...configOpts, ...depositOpts, ...fetchOpts, ...fillOpts, ...fetchDepositOpts],
    boolean: ["decimals", "execute"], // @dev tbd whether this is good UX or not...may need to change.
    default: {
      wallet: "secret",
      decimals: false,
    },
    alias: {
      transactionHash: "txnHash",
    },
    unknown: usage,
  };
  const args = minimist(argv.slice(1), opts);

  config();
  const cmd = argv[0];
  let signer: Signer;
  try {
    const keyType = ["deposit", "fill"].includes(cmd) ? args.wallet : "void";
    signer = await getSigner({ keyType, cleanEnv: true });
  } catch (err) {
    return usage(args.wallet) ? NODE_SUCCESS : NODE_INPUT_ERR;
  }

  let result: boolean;
  switch (cmd) {
    case "deposit":
      result = await deposit(args, signer);
      break;
    case "dump":
      result = await dumpConfig(args, signer);
      break;
    case "fetch":
      result = await fetchTxn(args, signer);
      break;
    case "fill":
      result = await fillDeposit(args, signer);
      break;
    default:
      return usage(cmd) ? NODE_SUCCESS : NODE_INPUT_ERR;
  }

  return result ? NODE_SUCCESS : NODE_APP_ERR;
}

if (require.main === module) {
  run(process.argv.slice(2))
    .then(async (result) => {
      process.exitCode = result;
    })
    .catch(async (error) => {
      console.error("Process exited with", error);
      process.exitCode = NODE_APP_ERR;
    });
}

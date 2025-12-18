import assert from "assert";
import axios, { isAxiosError } from "axios";
import minimist from "minimist";
import { groupBy } from "lodash";
import { config } from "dotenv";
import { Contract, ethers, Signer } from "ethers";
import { LogDescription } from "@ethersproject/abi";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { constants as sdkConsts, utils as sdkUtils } from "@across-protocol/sdk";
import { ExpandedERC20__factory as ERC20 } from "@across-protocol/contracts";
import { RelayData } from "../src/interfaces";
import { EventListener, getAcrossHost } from "../src/clients";
import {
  BigNumber,
  blockExplorerLink,
  Address,
  disconnectRedisClients,
  EvmAddress,
  exit,
  formatFeePct,
  getDeploymentBlockNumber,
  getMessageHash,
  getNetworkName,
  getProvider,
  getSigner,
  isDefined,
  Logger as logger,
  populateV3Relay,
  spreadEventWithBlockNumber,
  toBN,
  toAddressType,
  unpackDepositEvent,
  unpackFillEvent,
  chainIsEvm,
} from "../src/utils";
import * as utils from "./utils";

type Log = ethers.providers.Log;

type RelayerFeeQuery = {
  originChainId: number;
  destinationChainId: number;
  token: string;
  amount: string;
  recipientAddress?: string;
  message?: string;
  skipAmountLimit?: string;
  timestamp?: number;
};

// Teach BigInt how to be represented as JSON.
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

const { NODE_SUCCESS, NODE_INPUT_ERR, NODE_APP_ERR } = utils;
const { fixedPointAdjustment: fixedPoint } = sdkUtils;
const { AddressZero } = ethers.constants;

const DEPOSIT_EVENT = "FundsDeposited";
const FILL_EVENT = "FilledRelay";

/**
 * Resolves a list of token symbols for a list of token addresses and a chain ID.
 * @dev This function is dangerous because multiple token addresses can map to the same token symbol
 * so the output can be unexpected.
 * @param tokenAddresses The token addresses to resolve the symbols for.
 * @param chainId The chain ID to resolve the symbols for.
 * @returns The token symbols for the given token addresses and chain ID. Undefined symbols are filtered out.
 */
function resolveTokenSymbols(tokenAddresses: string[], chainId: number): string[] {
  const tokenSymbols = Object.values(TOKEN_SYMBOLS_MAP);
  return tokenAddresses
    .map((tokenAddress) => {
      return tokenSymbols.find(({ addresses }) => addresses[chainId]?.toLowerCase() === tokenAddress.toLowerCase())
        ?.symbol;
    })
    .filter(Boolean);
}

function decodeRelayData(originChainId: number, destinationChainId: number, log: LogDescription): RelayData {
  const eventArgs = Object.keys(log.args).filter((key) => isNaN(Number(key)));
  const relayData = Object.fromEntries(
    eventArgs.map((key) => {
      switch (key) {
        case "depositor":
        case "inputToken":
          return [key, toAddressType(log.args[key], originChainId)];

        case "recipient":
        case "outputToken":
        case "exclusiveRelayer":
          return [key, toAddressType(log.args[key], destinationChainId)];

        default:
          return [key, log.args[key]];
      }
    })
  ) as Omit<RelayData, "originChainId">;

  return {
    ...relayData,
    originChainId,
  };
}

function printRelayData(
  relayData: RelayData & { message?: string; messageHash?: string },
  destinationChainId: number,
  transactionHash?: string
): void {
  const relayDataHash = relayData.message ? sdkUtils.getRelayDataHash({ ...relayData }, destinationChainId) : undefined;

  let { messageHash } = relayData;
  messageHash ??= relayData.message ? getMessageHash(relayData.message) : undefined;

  const fields = {
    tokenSymbol: resolveTokenSymbols([relayData.inputToken.toNative()], relayData.originChainId)[0],
    ...relayData,
    messageHash,
    relayDataHash,
    transactionHash,
  };
  const padLeft = Object.keys(fields).reduce((acc, cur) => (cur.length > acc ? cur.length : acc), 0);
  const [eventType, chainId] = relayData.message
    ? ["Deposit", relayData.originChainId]
    : [`Fill for ${getNetworkName(relayData.originChainId)} deposit`, destinationChainId];

  console.log(
    `${eventType} # ${relayData.depositId} on ${getNetworkName(chainId)}:\n` +
      Object.entries(fields)
        .filter(([, value]) => isDefined(value))
        .map(([k, v]) => `\t${k.padEnd(padLeft)} : ${v}`)
        .join("\n") +
      "\n"
  );
}

function printDeposit(originChainId: number, log: LogDescription, transactionHash?: string): void {
  const { destinationChainId } = log.args;
  const relayData = decodeRelayData(originChainId, destinationChainId, log);
  printRelayData(relayData, destinationChainId, transactionHash);
}

function printFill(destinationChainId: number, log: LogDescription, transactionHash?: string): void {
  const { originChainId } = log.args;
  const relayData = decodeRelayData(originChainId, destinationChainId, log);
  printRelayData(relayData, destinationChainId, transactionHash);
}

async function getSuggestedFees(params: RelayerFeeQuery, timeout: number) {
  const hubChainId = sdkUtils.chainIsProd(params.originChainId) ? CHAIN_IDs.MAINNET : CHAIN_IDs.SEPOLIA;
  const path = "api/suggested-fees";
  const url = `https://${getAcrossHost(hubChainId)}/${path}`;

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
  recipient?: Address,
  message?: string
): Promise<{
  outputToken: Address;
  outputAmount: BigNumber;
  exclusiveRelayer: Address;
  exclusivityDeadline: number;
  quoteTimestamp: number;
  fillDeadline: number;
}> {
  const tokenFormatter = sdkUtils.createFormatFunction(2, 4, false, token.decimals);
  let quoteAccepted = false;

  const params = {
    token: token.address,
    originChainId: fromChainId,
    destinationChainId: toChainId,
    amount: amount.toString(),
    recipientAddress: recipient.toNative(),
    message,
  };
  const timeout = 5000;

  const suggestedFees = async () => {
    const quoteData = await getSuggestedFees(params, timeout);
    const {
      outputToken: { address: outputToken },
      outputAmount,
      totalRelayFee: { total: totalRelayFee },
      exclusiveRelayer,
      exclusivityDeadline,
      timestamp: quoteTimestamp,
      estimatedFillTimeSec: estimatedFillTime,
      fillDeadline,
    } = quoteData;

    [
      totalRelayFee,
      exclusiveRelayer,
      exclusivityDeadline,
      quoteTimestamp,
      estimatedFillTime,
      fillDeadline,
      outputToken,
    ].forEach((field) => {
      if (!isDefined(field)) {
        throw new Error("Incomplete suggested-fees response");
      }
    });

    return {
      outputToken: toAddressType(outputToken, toChainId),
      outputAmount: toBN(outputAmount),
      totalRelayFee: toBN(totalRelayFee),
      exclusiveRelayer: toAddressType(exclusiveRelayer, toChainId),
      exclusivityDeadline: Number(exclusivityDeadline),
      estimatedFillTime: Number(estimatedFillTime),
      quoteTimestamp: Number(quoteTimestamp),
      fillDeadline: Number(fillDeadline),
    };
  };

  let outputToken: Address;
  let outputAmount: BigNumber;
  let exclusiveRelayer: Address;
  let exclusivityDeadline: number;
  let quoteTimestamp: number;
  let fillDeadline: number;
  do {
    let totalRelayFee: BigNumber;
    let estimatedFillTime: number;
    ({
      outputToken,
      outputAmount,
      totalRelayFee,
      exclusivityDeadline,
      exclusiveRelayer,
      quoteTimestamp,
      estimatedFillTime,
      fillDeadline,
    } = await suggestedFees());

    outputAmount = amount.sub(totalRelayFee);
    const quote =
      `Quote for ${tokenFormatter(amount)} ${token.symbol} ${fromChainId} -> ${toChainId}:` +
      ` ${formatFeePct(totalRelayFee)} ${token.symbol} (${formatFeePct(totalRelayFee.mul(fixedPoint).div(amount))} %)` +
      ` (ETA ${estimatedFillTime} s)`;
    quoteAccepted = await utils.askYesNoQuestion(quote);
  } while (!quoteAccepted);

  return { outputToken, outputAmount, exclusiveRelayer, exclusivityDeadline, quoteTimestamp, fillDeadline };
}

async function deposit(args: Record<string, number | string>, signer: Signer): Promise<boolean> {
  const [fromChainId, toChainId, baseAmount] = [args.from, args.to, args.amount].map(Number);
  if (!utils.validateChainIds([fromChainId, toChainId])) {
    console.log(`Invalid set of chain IDs (${fromChainId}, ${toChainId}).`);
    return false;
  }

  // todo: only EVM `fromChainId`s are supported now
  assert(chainIsEvm(fromChainId));
  const depositor = toAddressType(await signer.getAddress(), fromChainId);
  const recipient = toAddressType(String(args.recipient ?? depositor.toNative()), toChainId);

  if (!recipient.isValidOn(toChainId)) {
    console.log(`Invalid recipient address for chain ${toChainId}: (${recipient}).`);
    return false;
  }

  const message = String(args.message ?? sdkConsts.EMPTY_MESSAGE);

  const token = utils.resolveToken(args.token as string, fromChainId);
  const inputToken = toAddressType(token.address, fromChainId);
  const tokenSymbol = token.symbol.toUpperCase();
  const inputAmount = ethers.utils.parseUnits(baseAmount.toString(), args.decimals ? 0 : token.decimals);

  const provider = await getProvider(fromChainId);
  signer = signer.connect(provider);
  const spokePool = (await utils.getSpokePoolContract(fromChainId)).connect(signer);

  const erc20 = new Contract(token.address, ERC20.abi, signer);
  const [balance, allowance] = await Promise.all([
    erc20.balanceOf(depositor.toNative()),
    erc20.allowance(depositor.toNative(), spokePool.address),
  ]);

  if (inputAmount.gt(balance)) {
    const baseBalance = balance.div(toBN(10).pow(token.decimals));
    console.log(`Insufficient balance for ${baseAmount} ${tokenSymbol} deposit (${baseBalance}).`);
    return false;
  }

  if (inputAmount.gt(allowance)) {
    const approvalAmount = inputAmount.mul(5);
    const approval = await erc20.approve(spokePool.address, approvalAmount);
    console.log(`Approving SpokePool for ${approvalAmount} ${tokenSymbol}: ${approval.hash}.`);
    await approval.wait();
    console.log("Approval complete...");
  }

  const depositQuote = await getRelayerQuote(fromChainId, toChainId, token, inputAmount, recipient, message);

  // Use the exclusiveRelayer provided by the user if present; otherwise fall back to the
  // value supplied by the quote (for SVM chains this will be the zero address).
  const exclusiveRelayer = toAddressType(
    String(args.exclusiveRelayer ?? depositQuote.exclusiveRelayer.toNative()),
    toChainId
  );
  const exclusivityParameter = args.exclusivityDeadline
    ? Number(args.exclusivityDeadline)
    : depositQuote.exclusivityDeadline;

  const abortController = new AbortController();
  const srcListener = new EventListener(fromChainId, logger, 1);
  const dstListener = new EventListener(toChainId, logger, 1);

  const [fundsDeposited, filledRelay] = ["FundsDeposited", "FilledRelay"].map((event) =>
    spokePool.interface.getEvent(event).format(ethers.utils.FormatTypes.full)
  );
  const [srcSpokePool, dstSpokePool] = await Promise.all(
    [fromChainId, toChainId].map((chainId) => utils.getSpokePoolContract(chainId))
  );

  const submitted = performance.now();
  let confirmed: number, filled: number;

  const delta = (start: number, finish: number, decimals = 1) => ((finish - start) / 1000).toFixed(decimals);

  srcListener.onEvent(srcSpokePool.address, fundsDeposited, (log) => {
    const _deposit = unpackDepositEvent(spreadEventWithBlockNumber(log), fromChainId);
    const deposit = {
      ..._deposit,
      depositId: BigNumber.from(log.args.depositId.toString()), // todo
      inputAmount: BigNumber.from(log.args.inputAmount.toString()), // todo
      outputAmount: BigNumber.from(log.args.outputAmount.toString()), // todo
      destinationChainId: Number(log.args.destinationChainId), // todo
    };
    if (deposit.depositor.eq(depositor)) {
      confirmed = performance.now();
      const depositTxn = blockExplorerLink(deposit.txnRef, fromChainId);
      printRelayData(deposit, deposit.destinationChainId, deposit.txnRef);
      console.log(`Deposit confirmed after ${delta(submitted, confirmed)} seconds: ${depositTxn}.`);
    }
  });

  dstListener.onEvent(dstSpokePool.address, filledRelay, (log) => {
    const fill = unpackFillEvent(spreadEventWithBlockNumber(log), toChainId);
    if (fill.depositor.eq(depositor)) {
      filled = performance.now();
      const fillTxn = blockExplorerLink(fill.txnRef, toChainId);
      console.log(`Fill confirmed after ${delta(confirmed, filled)} seconds: ${fillTxn}.`);
      abortController.abort();
    }
  });

  await spokePool.deposit(
    depositor.toBytes32(),
    recipient.toBytes32(),
    inputToken.toBytes32(),
    depositQuote.outputToken.toBytes32(),
    inputAmount,
    depositQuote.outputAmount,
    toChainId,
    exclusiveRelayer.toBytes32(),
    depositQuote.quoteTimestamp,
    depositQuote.fillDeadline,
    exclusivityParameter,
    message
  );

  return new Promise((resolve) => abortController.signal.addEventListener("abort", async () => resolve(true)));
}

async function fillDeposit(args: Record<string, number | string | boolean>, signer: Signer): Promise<boolean> {
  const { txnHash, depositId: depositIdArg, execute, slow } = args;
  const originChainId = Number(args.chainId);

  if (txnHash === undefined || typeof txnHash !== "string" || txnHash.length != 66 || !txnHash.startsWith("0x")) {
    throw new Error(`Missing or malformed transaction hash: ${txnHash}`);
  }

  const originProvider = await getProvider(originChainId);
  const originSpokePool = await utils.getSpokePoolContract(originChainId);
  const spokePools: { [chainId: number]: Contract } = {};

  const txn = await originProvider.getTransactionReceipt(txnHash);

  const fundsDeposited = originSpokePool.interface.getEventTopic(DEPOSIT_EVENT);
  const depositLogs = txn.logs
    .filter(({ topics, address }) => topics[0] === fundsDeposited && address === originSpokePool.address)
    .map((log) => originSpokePool.interface.parseLog(log));

  if (depositLogs.length === 0) {
    throw new Error("No deposits found in txn");
  }

  let depositArgs: ethers.utils.Result;
  if (depositIdArg === undefined) {
    if (depositLogs.length > 1) {
      throw new Error("Multiple deposits in transaction. Must provide depositId");
    }

    [{ args: depositArgs }] = depositLogs;
  } else {
    const foundDeposit = depositLogs.find((log) => log.args["depositId"] === depositIdArg);
    if (foundDeposit === undefined) {
      throw new Error(`No deposit found for id ${args["depositId"]}`);
    }
    ({ args: depositArgs } = foundDeposit);
  }

  const destinationChainId = Number(depositArgs.destinationChainId.toString());
  const destSpokePool = spokePools[destinationChainId] ?? (await utils.getSpokePoolContract(destinationChainId));

  const { symbol } = utils.resolveToken(depositArgs.inputToken, originChainId);
  const destinationTokenInfo = utils.resolveToken(symbol, destinationChainId);
  const rawOutputToken =
    depositArgs.outputToken === AddressZero ? destinationTokenInfo.address : depositArgs.outputToken;
  const outputAmount = toBN(depositArgs.outputAmount);

  const relayer = EvmAddress.from(await signer.getAddress());
  assert(relayer.isEVM());

  const recipient = sdkUtils.EvmAddress.from(depositArgs.recipient);
  const outputToken = sdkUtils.EvmAddress.from(rawOutputToken);

  const deposit = {
    depositId: depositArgs.depositId,
    originChainId,
    destinationChainId,
    depositor: toAddressType(depositArgs.depositor, originChainId),
    recipient,
    inputToken: toAddressType(depositArgs.inputToken, originChainId),
    inputAmount: depositArgs.inputAmount,
    outputToken,
    outputAmount,
    message: depositArgs.message,
    quoteTimestamp: depositArgs.quoteTimestamp,
    fillDeadline: depositArgs.fillDeadline,
    exclusivityDeadline: depositArgs.exclusivityDeadline,
    exclusiveRelayer: toAddressType(depositArgs.exclusiveRelayer, destinationChainId),
  };
  const fill = isDefined(slow)
    ? await destSpokePool.populateTransaction.requestSlowFill(deposit)
    : await populateV3Relay(destSpokePool, deposit, relayer);

  console.group("Fill Txn Info");
  console.log(`to: ${fill.to}`);
  console.log(`value: ${fill.value || "0"}`);
  console.log(`data: ${fill.data}`);
  console.groupEnd();

  if (execute) {
    const question = "Are you sure you want to send this fill?";
    const questionAccepted = await utils.askYesNoQuestion(question);
    if (!questionAccepted) {
      return true;
    }

    const sender = await signer.getAddress();
    const destProvider = await getProvider(destinationChainId);
    const destSigner = signer.connect(destProvider);

    const erc20 = new Contract(outputToken.toNative(), ERC20.abi, destSigner);
    const allowance = await erc20.allowance(sender, destSpokePool.address);
    if (outputAmount.gt(allowance)) {
      const approvalAmount = outputAmount.mul(5);
      const approval = await erc20.approve(destSpokePool.address, approvalAmount);
      console.log(`Approving SpokePool for ${approvalAmount} ${symbol}: ${approval.hash}.`);
      await approval.wait();
      console.log("Approval complete...");
    }

    const fillTxn = await destSigner.sendTransaction(fill);
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
  const spokeProvider = await getProvider(chainId);
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
  const filter = spokePool.filters.FundsDeposited(null, null, null, null, null, depositId);

  // @note: Querying over such a large block range typically only works on top-tier providers.
  // @todo: Narrow the block range for the depositId, subject to this PR:
  //        https://github.com/across-protocol/sdk/pull/476
  return await spokePool.queryFilter(filter, deploymentBlockNumber, latestBlockNumber);
}

async function _fetchTxn(spokePool: Contract, txnHash: string): Promise<{ deposits: Log[]; fills: Log[] }> {
  if (txnHash === undefined || typeof txnHash !== "string" || txnHash.length != 66 || !txnHash.startsWith("0x")) {
    throw new Error(`Missing or malformed transaction hash: ${txnHash}`);
  }

  const txn = await spokePool.provider.getTransactionReceipt(txnHash);
  const fundsDeposited = spokePool.interface.getEventTopic(DEPOSIT_EVENT);
  const filledRelay = spokePool.interface.getEventTopic(FILL_EVENT);
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

  const provider = await getProvider(chainId);
  const spokePool = (await utils.getSpokePoolContract(chainId)).connect(provider);

  let deposits: Log[] = [];
  let fills: Log[] = [];
  if (args.depositId) {
    deposits = await _fetchDeposit(spokePool, args.depositId);
  } else if (txnHash) {
    ({ deposits, fills } = await _fetchTxn(spokePool, txnHash as string));
  }

  deposits.forEach(({ transactionHash, ...deposit }) => {
    printDeposit(chainId, spokePool.interface.parseLog(deposit), transactionHash);
  });

  fills.forEach(({ transactionHash, ...fill }) => {
    printFill(chainId, spokePool.interface.parseLog(fill), transactionHash);
  });

  return true;
}

function usage(badInput?: string): boolean {
  let usageStr = badInput ? `\nUnrecognized input: "${badInput}".\n\n` : "";
  const walletOpts = "mnemonic|privateKey";
  const depositArgs =
    "--from <originChainId> --to <destinationChainId>" +
    " --token <tokenSymbol> --amount <amount>" +
    " [--recipient <recipient>] [--decimals]" +
    " [--relayer <exclusiveRelayer> --exclusivityDeadline <exclusivityDeadline>]";

  const dumpConfigArgs = "--chainId";
  const fetchArgs = "--chainId <chainId> [--depositId <depositId> | --txnHash <txnHash>]";
  const fillArgs = "--chainId <originChainId> --txnHash <depositHash> [--depositId <depositId>] [--slow] [--execute]";

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
  const depositOpts = [
    "from",
    "to",
    "token",
    "amount",
    "recipient",
    "message",
    "exclusiveRelayer",
    "exclusivityDeadline",
  ];
  const fetchOpts = ["chainId", "transactionHash", "depositId"];
  const fillOpts = ["txnHash", "chainId", "depositId"];
  const fetchDepositOpts = ["chainId", "depositId"];
  const opts = {
    string: ["wallet", ...configOpts, ...depositOpts, ...fetchOpts, ...fillOpts, ...fetchDepositOpts],
    boolean: ["decimals", "execute", "slow"], // @dev tbd whether this is good UX or not...may need to change.
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
    })
    .finally(async () => {
      await disconnectRedisClients();
      exit(Number(process.exitCode));
    });
}

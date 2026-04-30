/*
Usage example:

yarn ts-node ./scripts/swapOnBinance.ts \
  --srcToken USDC \
  --srcChain 137 \
  --dstToken TRX \
  --dstChain 728126428 \
  --amount 10 \
  --recipient <DESTINATION_ADDRESS> \
  --wallet <WALLET_MODE>

Provide Binance credentials through the standard repo auth inputs for your environment.
If your signer or Binance secret is GCKMS-backed, run the script under with-gcp-auth.
*/

import assert from "assert";
import minimist from "minimist";
import winston from "winston";
import { Binance, DepositAddress, NewOrderSpot, OrderType, QueryOrderResult } from "binance-api-node";
import { askYesNoQuestion } from "./utils";
import { BinanceClient } from "../src/clients/BinanceClient";
import { AugmentedTransaction, TransactionClient } from "../src/clients";
import {
  BINANCE_NETWORKS,
  BINANCE_WITHDRAWAL_STATUS,
  BinanceDeposit,
  BinanceTransactionType,
  BinanceWithdrawal,
  BigNumber,
  SpotMarketMeta,
  CHAIN_IDs,
  Coin,
  ConvertDecimals,
  TOKEN_SYMBOLS_MAP,
  blockExplorerLink,
  chainIsSvm,
  chainIsTvm,
  compareAddressesSimple,
  Contract,
  convertBinanceRouteAmount,
  createFormatFunction,
  deriveBinanceSpotMarketMeta,
  ERC20,
  formatGwei,
  fromWei,
  getAtomicDepositorContracts,
  getAccountCoins,
  getBinanceDeposits,
  getBinanceWithdrawals,
  getEthersCompatibleAddress,
  getFillCommission,
  getGasPrice,
  getNetworkName,
  getNativeTokenInfoForChain,
  getProvider,
  getRedisCache,
  getSolanaTokenBalance,
  getSvmProvider,
  getTokenInfoFromSymbol,
  getWrappedNativeTokenAddress,
  isDefined,
  isFailedBinanceWithdrawal,
  MAX_SAFE_ALLOWANCE,
  parseUnits,
  resolveBinanceCoinSymbol,
  resolveAcrossToken,
  retrieveSignerFromCLIArgs,
  setBinanceDepositType,
  setBinanceWithdrawalType,
  Signer,
  submitTransaction,
  SvmAddress,
  toAddressType,
  toBNWei,
  toKitAddress,
  truncate,
  willSucceed,
  readableBinanceWithdrawalStatus,
} from "../src/utils";
import { getCloidForAccount } from "../src/rebalancer/utils/utils";

// Time between polling attempts when waiting on asynchronous operations to complete.
const POLL_DELAY_MS = 5_000;

// TTL to set for cached deposit data initiated by this script.
const SWAP_DEPOSIT_TYPE_TTL_SECONDS = 30 * 60;

// Conservative fallback for bridge gas when an approval step must land before the bridge can be simulated.
const APPROVAL_DEPENDENT_BRIDGE_GAS_LIMIT_FALLBACK = BigNumber.from(250_000);

type ParsedSwapArgs = minimist.ParsedArgs;
type BinanceAssetNetwork = Coin["networkList"][number];

export type BinanceSourceDepositMode = "erc20" | "native";

export interface ResolvedBinanceAsset {
  tokenSymbol: string;
  chainId: number;
  binanceCoin: string;
  network: BinanceAssetNetwork;
  tokenDecimals: number;
  isNativeAsset: boolean;
  localTokenAddress?: string;
  depositMode?: BinanceSourceDepositMode;
}

export type BinanceAssetResolutionFailureReason =
  | "UNKNOWN_TOKEN"
  | "UNSUPPORTED_CHAIN"
  | "CONTRACT_ADDRESS_MISMATCH"
  | "NATIVE_SOURCE_ATOMIC_DEPOSITOR_REQUIRED"
  | "DEPOSIT_DISABLED"
  | "WITHDRAW_DISABLED"
  | "MEMO_REQUIRED";

type BinanceAssetResolutionResult =
  | { ok: true; asset: ResolvedBinanceAsset }
  | { ok: false; reason: BinanceAssetResolutionFailureReason };

export interface BinanceQuote {
  spotMarketMeta: SpotMarketMeta;
  latestPrice: number;
  slippagePct: number;
  tradeFeePct: number;
  tradeFeeSourceToken: BigNumber;
  tradeFeeDestinationToken: BigNumber;
  slippageFeeSourceToken: BigNumber;
  withdrawalFeeDestinationToken: BigNumber;
  withdrawalFeeSourceToken: BigNumber;
  totalFeeSourceToken: BigNumber;
  expectedDestinationAmount: BigNumber;
  expectedNetDestinationAmount: BigNumber;
}

export interface BinanceDepositAvailability {
  attempts: number;
  deposit: BinanceDeposit;
  freeBalance: number;
}

export interface BinanceOrderFillAvailability {
  attempts: number;
  freeBalance: number;
  matchingFill: QueryOrderResult;
  expectedAmountToReceive: string;
}

export interface BinanceWithdrawalCompletion {
  attempts: number;
  observedCompletedAtMs: number;
  withdrawal: BinanceWithdrawal;
}

type DepositGasEstimate = {
  gasLimit: BigNumber;
  gasPrice: BigNumber;
  maxPriorityFeePerGas: BigNumber;
  gasCost: BigNumber;
  priorityFeeScaler: number;
  maxFeePerGasScaler: number;
};

type DepositPlanStep = {
  label: string;
  transaction: AugmentedTransaction;
};

type DepositExecutionPlan = {
  steps: DepositPlanStep[];
};

enum BinanceDepositStatus {
  Pending = 0,
  Confirmed = 1,
  Rejected = 2,
  Credited = 6,
  WrongDeposit = 7,
  WaitingUserConfirm = 8,
}

const BINANCE_DEPOSIT_STATUS_LABELS: Record<number, string> = {
  [BinanceDepositStatus.Pending]: "pending",
  [BinanceDepositStatus.Confirmed]: "confirmed",
  [BinanceDepositStatus.Rejected]: "rejected",
  [BinanceDepositStatus.Credited]: "credited",
  [BinanceDepositStatus.WrongDeposit]: "wrong-deposit",
  [BinanceDepositStatus.WaitingUserConfirm]: "waiting-user-confirm",
};

export async function run(): Promise<void> {
  const { args, normalizedArgv } = parseCliArgs();
  const logger = winston.createLogger({
    level: "info",
    format: winston.format.simple(),
    transports: [new winston.transports.Console()],
  });

  printSection("Binance Swap");
  assertExplicitWalletFlag(normalizedArgv);

  const srcToken = requiredStringFlag(args, "srcToken").toUpperCase();
  const dstToken = requiredStringFlag(args, "dstToken").toUpperCase();
  const srcChain = requiredChainFlag(args, "srcChain");
  const dstChain = requiredChainFlag(args, "dstChain");
  const recipient = requiredStringFlag(args, "recipient");
  const rawAmount = requiredStringFlag(args, "amount");
  const priorityFeeScaler = optionalNumberFlag(args, "priorityFeeScaler", 1.2);
  const maxFeePerGasScaler = optionalNumberFlag(args, "maxFeePerGasScaler", 3);

  const binanceClient = await BinanceClient.create({ logger, url: process.env["BINANCE_API_BASE"] });
  const venue = new BinanceSwapVenue(binanceClient.rawApi());
  const accountCoins = await getAccountCoins(binanceClient.rawApi());
  const sourceResolution = resolveBinanceAsset({
    accountCoins,
    tokenSymbol: srcToken,
    chainId: srcChain,
    direction: "deposit",
  });
  if (sourceResolution.ok === false) {
    throw new Error(
      buildAssetResolutionError("source", srcToken, srcChain, "deposit", accountCoins, sourceResolution.reason)
    );
  }
  const destinationResolution = resolveBinanceAsset({
    accountCoins,
    tokenSymbol: dstToken,
    chainId: dstChain,
    direction: "withdraw",
  });
  if (destinationResolution.ok === false) {
    throw new Error(
      buildAssetResolutionError(
        "destination",
        dstToken,
        dstChain,
        "withdraw",
        accountCoins,
        destinationResolution.reason
      )
    );
  }

  const source = sourceResolution.asset;
  const destination = destinationResolution.asset;
  if (source.binanceCoin === destination.binanceCoin) {
    throw new Error(
      `Source token ${srcToken} and destination token ${dstToken} both resolve to Binance coin ${source.binanceCoin}. This script only supports routes that require a Binance spot swap.`
    );
  }
  if (!isValidRecipientForChain(recipient, dstChain)) {
    throw new Error(`Recipient ${recipient} is not a valid address on ${getNetworkName(dstChain)} (${dstChain})`);
  }

  const signer = await retrieveSignerFromCLIArgs();
  const signerAddress = toAddressType(await signer.getAddress(), srcChain).toNative();
  const connectedSigner = signer.connect(await getProvider(srcChain));
  const amount = parseAmount(rawAmount, source.tokenDecimals);
  const depositAddress = await getDepositAddressOrThrow(venue, source);
  const depositPlan = await buildDepositExecutionPlan(source, connectedSigner, depositAddress, amount);
  const depositGasEstimate = await estimateDepositGas(depositPlan, { priorityFeeScaler, maxFeePerGasScaler });
  const balances = await gatherPreflightBalances(source, signer, amount, depositGasEstimate.gasCost, accountCoins);
  if (balances.shortfallMessage) {
    throw new Error(balances.shortfallMessage);
  }
  const recipientBalances = await gatherRecipientBalances(destination, recipient);

  const quote = await venue.getQuote(source, destination, amount);
  validateQuote(destination, quote);
  const withdrawalQuota = await binanceClient.getWithdrawalLimits();

  printPreflightSummary({
    signerAddress,
    recipient,
    source,
    destination,
    amount,
    balances,
    recipientBalances,
    quote,
    depositGasEstimate,
    withdrawalQuotaUsed: withdrawalQuota.usedWdQuota,
    withdrawalQuotaTotal: withdrawalQuota.wdQuota,
  });

  if (!(await askYesNoQuestion("\nProceed with this Binance swap?"))) {
    console.log("Swap cancelled.");
    return;
  }

  printSection("Step 1/4: Deposit");
  console.log(
    `Preparing to send ${formatAmount(amount, source.tokenDecimals)} ${srcToken} on ${getNetworkName(srcChain)}...`
  );
  const depositSubmittedAtMs = Date.now();
  const transactionClient = new TransactionClient(logger);
  let depositResponse;
  for (const [index, step] of depositPlan.steps.entries()) {
    console.log(`[deposit ${index + 1}/${depositPlan.steps.length}] ${step.label}`);
    depositResponse = await submitTransaction(step.transaction, transactionClient);
    console.log(`Transaction confirmed: ${blockExplorerLink(depositResponse.hash, srcChain)}`);
  }
  assert(isDefined(depositResponse), "Deposit plan did not produce a final transaction response");
  await setBinanceDepositType(
    srcChain,
    depositResponse.hash,
    BinanceTransactionType.SWAP,
    SWAP_DEPOSIT_TYPE_TTL_SECONDS
  );
  console.log(`Binance deposit address: ${depositAddress.address}`);

  printSection("Step 2/4: Wait For Binance Balance");
  const requiredSourceFreeBalance = Number(fromWei(amount, source.tokenDecimals));
  let timeElapsedMsStart = Date.now();
  await waitForBinanceDepositToBeAvailable({
    venue,
    source,
    depositTxHash: depositResponse.hash,
    minFreeBalance: requiredSourceFreeBalance,
    startTimeMs: depositSubmittedAtMs - 60_000,
    pollDelayMs: POLL_DELAY_MS,
    onProgress: ({ attempts, deposit, freeBalance }) => {
      console.log(
        `[poll ${attempts}, elapsed: ${Math.round((Date.now() - timeElapsedMsStart) / 1000)}s] deposit status=${formatBinanceDepositPollStatus(deposit)} free=${freeBalance} ${source.binanceCoin} required=${requiredSourceFreeBalance}`
      );
    },
  });

  printSection("Step 3/4: Swap");
  const orderId = getCloidForAccount(await signer.getAddress());
  const fill = await venue.placeMarketOrder(orderId, source, destination, amount);
  console.log(`Market ${fill.side} order placed and filled: `, fill);

  timeElapsedMsStart = Date.now();
  const orderAvailability = await waitForBinanceOrderFillAndBalance({
    venue,
    cloid: orderId,
    source,
    destination,
    pollDelayMs: POLL_DELAY_MS,
    onProgress: ({ attempts, freeBalance, requiredBalance, matchingFill }) => {
      console.log(
        `[poll ${attempts}, elapsed: ${Math.round((Date.now() - timeElapsedMsStart) / 1000)}s] order=${matchingFill?.status ?? "pending"} free=${freeBalance} ${destination.binanceCoin} required=${requiredBalance ?? "pending"}`
      );
    },
  });
  const amountToWithdraw = toBNWei(
    truncate(Number(orderAvailability.expectedAmountToReceive), destination.tokenDecimals),
    destination.tokenDecimals
  );

  printSection("Step 4/4: Withdraw");
  const withdrawalSubmittedAtMs = Date.now();
  const withdrawalId = await venue.initiateWithdrawal(destination, recipient, amountToWithdraw);
  await setBinanceWithdrawalType(dstChain, withdrawalId, BinanceTransactionType.SWAP);
  console.log(`Withdrawal requested from Binance with id ${withdrawalId}.`);

  timeElapsedMsStart = Date.now();
  const completedWithdrawal = await waitForBinanceWithdrawalCompletion({
    venue,
    destination,
    withdrawalId,
    startTimeMs: withdrawalSubmittedAtMs - 60_000,
    pollDelayMs: POLL_DELAY_MS,
    onProgress: ({ attempts, withdrawal }) => {
      console.log(formatWithdrawalProgressLine({ attempts, elapsedMs: Date.now() - timeElapsedMsStart, withdrawal }));
    },
  });

  printSection("Complete");
  const withdrawalFeeDestinationToken = toBNWei(
    truncate(Number(destination.network.withdrawFee), destination.tokenDecimals),
    destination.tokenDecimals
  );
  const expectedRecipientAmount = amountToWithdraw.gt(withdrawalFeeDestinationToken)
    ? amountToWithdraw.sub(withdrawalFeeDestinationToken)
    : BigNumber.from(0);
  console.log(`Recipient explorer: ${blockExplorerLink(recipient, dstChain)}`);
  if (completedWithdrawal.withdrawal.txId) {
    console.log(`Withdrawal tx: ${blockExplorerLink(completedWithdrawal.withdrawal.txId, dstChain)}`);
  }
  console.log(
    `Withdrawal request amount: ${formatAmount(amountToWithdraw, destination.tokenDecimals)} ${dstToken} on ${getNetworkName(
      dstChain
    )}`
  );
  console.log(
    `Expected recipient amount: ${formatAmount(expectedRecipientAmount, destination.tokenDecimals)} ${dstToken} on ${getNetworkName(
      dstChain
    )}`
  );
  console.log(
    `Binance marked the withdrawal completed at ${new Date(completedWithdrawal.observedCompletedAtMs).toISOString()}`
  );
}

type PreflightBalances = {
  sourceBalance: BigNumber;
  nativeBalance: BigNumber;
  shortfallMessage?: string;
};

type RecipientBalances = {
  destinationTokenBalance: BigNumber;
  nativeBalance: BigNumber;
};

async function gatherPreflightBalances(
  source: ResolvedBinanceAsset,
  signer: Signer,
  amount: BigNumber,
  estimatedGasCost: BigNumber,
  accountCoins: Coin[]
): Promise<PreflightBalances> {
  const provider = await getProvider(source.chainId);
  const connectedSigner = signer.connect(provider);
  const signerAddress = await connectedSigner.getAddress();
  const nativeBalance = await provider.getBalance(signerAddress);
  const nativeSymbol = getNativeTokenInfoForChain(source.chainId).symbol;
  const sourceBalance = source.isNativeAsset
    ? await new Contract(getWrappedNativeTokenAddress(source.chainId).toNative(), ERC20.abi, connectedSigner).balanceOf(
        signerAddress
      )
    : await new Contract(
        getEthersCompatibleAddress(source.chainId, source.localTokenAddress!),
        ERC20.abi,
        connectedSigner
      ).balanceOf(signerAddress);

  let shortfallMessage: string | undefined;
  if (source.isNativeAsset) {
    if (sourceBalance.lt(amount)) {
      shortfallMessage = [
        `Insufficient ${source.tokenSymbol} balance available for Binance deposit on ${getNetworkName(source.chainId)} (${source.chainId}).`,
        `Current balance available for deposit: ${formatAmount(sourceBalance, source.tokenDecimals)} ${source.tokenSymbol}`,
        `Swap amount: ${formatAmount(amount, source.tokenDecimals)} ${source.tokenSymbol}`,
        `Additional amount required: ${formatAmount(amount.sub(sourceBalance), source.tokenDecimals)} ${source.tokenSymbol}`,
        `Current ${nativeSymbol} balance for gas: ${formatAmount(nativeBalance, getNativeTokenInfoForChain(source.chainId).decimals)} ${nativeSymbol}`,
        `Estimated gas cost: ${formatAmount(estimatedGasCost, getNativeTokenInfoForChain(source.chainId).decimals)} ${nativeSymbol}`,
        await formatOtherKnownBalances(source.chainId, signer, source.tokenSymbol, accountCoins),
      ].join("\n");
    } else if (nativeBalance.lt(estimatedGasCost)) {
      shortfallMessage = [
        `Insufficient ${nativeSymbol} balance to pay for the source-chain deposit transaction on ${getNetworkName(source.chainId)} (${source.chainId}).`,
        `Current ${nativeSymbol} balance: ${formatAmount(nativeBalance, getNativeTokenInfoForChain(source.chainId).decimals)} ${nativeSymbol}`,
        `Estimated gas cost: ${formatAmount(estimatedGasCost, getNativeTokenInfoForChain(source.chainId).decimals)} ${nativeSymbol}`,
        `Additional native balance required: ${formatAmount(estimatedGasCost.sub(nativeBalance), getNativeTokenInfoForChain(source.chainId).decimals)} ${nativeSymbol}`,
        await formatOtherKnownBalances(source.chainId, signer, source.tokenSymbol, accountCoins),
      ].join("\n");
    }
  } else {
    if (sourceBalance.lt(amount)) {
      shortfallMessage = [
        `Insufficient ${source.tokenSymbol} balance on ${getNetworkName(source.chainId)} (${source.chainId}).`,
        `Current balance: ${formatAmount(sourceBalance, source.tokenDecimals)} ${source.tokenSymbol}`,
        `Additional amount required: ${formatAmount(amount.sub(sourceBalance), source.tokenDecimals)} ${source.tokenSymbol}`,
        await formatOtherKnownBalances(source.chainId, signer, source.tokenSymbol, accountCoins),
      ].join("\n");
    } else if (nativeBalance.lt(estimatedGasCost)) {
      shortfallMessage = [
        `Insufficient ${nativeSymbol} balance to pay for the source-chain deposit transaction on ${getNetworkName(source.chainId)} (${source.chainId}).`,
        `Current ${nativeSymbol} balance: ${formatAmount(nativeBalance, getNativeTokenInfoForChain(source.chainId).decimals)} ${nativeSymbol}`,
        `Estimated gas cost: ${formatAmount(estimatedGasCost, getNativeTokenInfoForChain(source.chainId).decimals)} ${nativeSymbol}`,
        `Additional native balance required: ${formatAmount(estimatedGasCost.sub(nativeBalance), getNativeTokenInfoForChain(source.chainId).decimals)} ${nativeSymbol}`,
        await formatOtherKnownBalances(source.chainId, signer, source.tokenSymbol, accountCoins),
      ].join("\n");
    }
  }

  return { sourceBalance, nativeBalance, shortfallMessage };
}

async function formatOtherKnownBalances(
  chainId: number,
  signer: Signer,
  excludedSymbol: string,
  accountCoins: Coin[]
): Promise<string> {
  const candidateSymbols = getEligibleKnownTokensForChain(accountCoins, chainId, "deposit").filter(
    (symbol) => symbol !== excludedSymbol
  );
  const provider = await getProvider(chainId);
  const connectedSigner = signer.connect(provider);
  const address = await connectedSigner.getAddress();

  const balanceLines = await Promise.all(
    candidateSymbols.map(async (symbol) => {
      try {
        const nativeSymbol = getNativeTokenInfoForChain(chainId).symbol.toUpperCase();
        const isNativeCandidate = symbol === nativeSymbol;

        const balance = isNativeCandidate
          ? await provider.getBalance(address)
          : await new Contract(
              getEthersCompatibleAddress(chainId, resolveAcrossToken(symbol, chainId)!),
              ERC20.abi,
              connectedSigner
            ).balanceOf(address);
        if (balance.lte(BigNumber.from(0))) {
          return undefined;
        }

        const decimals = isNativeCandidate
          ? getNativeTokenInfoForChain(chainId).decimals
          : getTokenInfoFromSymbol(symbol, chainId).decimals;
        return `- ${formatAmount(balance, decimals)} ${symbol}`;
      } catch {
        return undefined;
      }
    })
  );

  const balances = balanceLines.filter(isDefined);
  if (balances.length === 0) {
    return "Other Binance-eligible known token balances on the source chain: none found.";
  }
  return ["Other Binance-eligible known token balances on the source chain:", ...balances].join("\n");
}

async function gatherRecipientBalances(
  destination: ResolvedBinanceAsset,
  recipient: string
): Promise<RecipientBalances> {
  if (chainIsSvm(destination.chainId)) {
    const provider = getSvmProvider(await getRedisCache(), undefined, destination.chainId);
    const recipientAddress = SvmAddress.from(recipient);
    const nativeBalanceResponse = await provider.getBalance(toKitAddress(recipientAddress)).send();
    const nativeBalance = BigNumber.from(nativeBalanceResponse.value.toString());
    const destinationTokenBalance = destination.isNativeAsset
      ? nativeBalance
      : await getSolanaTokenBalance(provider, SvmAddress.from(destination.localTokenAddress!), recipientAddress);

    return {
      destinationTokenBalance,
      nativeBalance,
    };
  }

  const provider = await getProvider(destination.chainId);
  const recipientAddress = getEthersCompatibleAddress(destination.chainId, recipient);
  const nativeBalance = await provider.getBalance(recipientAddress);
  const destinationTokenBalance = destination.isNativeAsset
    ? nativeBalance
    : await new Contract(
        getEthersCompatibleAddress(destination.chainId, destination.localTokenAddress!),
        ERC20.abi,
        provider
      ).balanceOf(recipientAddress);

  return {
    destinationTokenBalance,
    nativeBalance,
  };
}

async function getDepositAddressOrThrow(
  venue: BinanceSwapVenue,
  source: ResolvedBinanceAsset
): Promise<DepositAddress> {
  const depositAddress = await venue.rawApi().depositAddress({
    coin: source.binanceCoin,
    network: source.network.name,
  });
  if (depositAddress.tag) {
    throw new Error(
      `Binance deposit network ${source.network.name} for ${source.binanceCoin} requires an address tag/memo. This script only supports plain-address deposits.`
    );
  }
  return depositAddress;
}

async function buildDepositExecutionPlan(
  source: ResolvedBinanceAsset,
  signer: Signer,
  depositAddress: DepositAddress,
  amount: BigNumber
): Promise<DepositExecutionPlan> {
  const chainId = source.chainId;
  if (source.isNativeAsset) {
    const contracts = getAtomicDepositorContracts(chainId);
    if (!contracts) {
      throw new Error(`Atomic depositor contracts are missing for ${getNetworkName(chainId)} (${chainId})`);
    }
    const signerAddress = await signer.getAddress();
    const wrappedNativeToken = new Contract(getWrappedNativeTokenAddress(chainId).toNative(), ERC20.abi, signer);
    const allowance = await wrappedNativeToken.allowance(signerAddress, contracts.atomicDepositorAddress);
    const steps: DepositPlanStep[] = [];
    if (allowance.lt(amount)) {
      steps.push({
        label: `Approve the AtomicWethDepositor for ${source.tokenSymbol} deposit`,
        transaction: {
          contract: wrappedNativeToken,
          method: "approve",
          args: [contracts.atomicDepositorAddress, MAX_SAFE_ALLOWANCE],
          chainId,
          nonMulticall: true,
          unpermissioned: false,
          ensureConfirmation: true,
          message: `Approve AtomicWethDepositor for ${source.tokenSymbol} deposit`,
          mrkdwn: `Approved AtomicWethDepositor for ${source.tokenSymbol} deposit`,
        },
      });
    }
    const atomicDepositor = new Contract(contracts.atomicDepositorAddress, contracts.atomicDepositorAbi, signer);
    const transferProxy = new Contract(contracts.transferProxyAddress, contracts.transferProxyAbi);
    const bridgeCalldata = transferProxy.interface.encodeFunctionData("transfer", [depositAddress.address]);
    steps.push({
      label: `Deposit ${formatAmount(amount, source.tokenDecimals)} ${source.tokenSymbol} into Binance via AtomicWethDepositor`,
      transaction: {
        contract: atomicDepositor,
        method: "bridgeWeth",
        args: [CHAIN_IDs.BSC, amount, amount, BigNumber.from(0), bridgeCalldata],
        chainId,
        nonMulticall: true,
        unpermissioned: false,
        ensureConfirmation: true,
        message: `Deposit ${formatAmount(amount, source.tokenDecimals)} ${source.tokenSymbol} into Binance via AtomicWethDepositor`,
        mrkdwn: `Deposited ${formatAmount(amount, source.tokenDecimals)} ${source.tokenSymbol} into Binance via AtomicWethDepositor`,
      },
    });
    return { steps };
  }

  const tokenContract = new Contract(getEthersCompatibleAddress(chainId, source.localTokenAddress!), ERC20.abi, signer);
  return {
    steps: [
      {
        label: `Transfer ${formatAmount(amount, source.tokenDecimals)} ${source.tokenSymbol} directly to the Binance deposit address`,
        transaction: {
          contract: tokenContract,
          method: "transfer",
          args: [getEthersCompatibleAddress(chainId, depositAddress.address), amount],
          chainId,
          nonMulticall: true,
          unpermissioned: false,
          ensureConfirmation: true,
          message: `Deposit ${formatAmount(amount, source.tokenDecimals)} ${source.tokenSymbol} into Binance`,
          mrkdwn: `Deposited ${formatAmount(amount, source.tokenDecimals)} ${source.tokenSymbol} into Binance`,
        },
      },
    ],
  };
}

export async function estimateDepositGas(
  depositPlan: DepositExecutionPlan,
  gasPricing: { priorityFeeScaler: number; maxFeePerGasScaler: number }
): Promise<DepositGasEstimate> {
  return estimateDepositGasWithDeps(depositPlan, gasPricing, { willSucceed, getGasPrice });
}

export async function estimateDepositGasWithDeps(
  depositPlan: DepositExecutionPlan,
  gasPricing: { priorityFeeScaler: number; maxFeePerGasScaler: number },
  deps: {
    willSucceed: typeof willSucceed;
    getGasPrice: typeof getGasPrice;
  }
): Promise<DepositGasEstimate> {
  assert(depositPlan.steps.length > 0, "Deposit plan must include at least one transaction");
  const gasLimits = await simulateDepositGasLimits(depositPlan, deps.willSucceed);
  const feeData = await deps.getGasPrice(
    depositPlan.steps[0].transaction.contract.provider,
    gasPricing.priorityFeeScaler,
    gasPricing.maxFeePerGasScaler
  );
  const gasPrice = feeData.maxFeePerGas ?? BigNumber.from(0);
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? BigNumber.from(0);
  const gasLimit = gasLimits.reduce((sum, stepGasLimit) => sum.add(stepGasLimit), BigNumber.from(0));
  const gasCost = gasLimit.mul(gasPrice);
  return {
    gasLimit,
    gasPrice,
    maxPriorityFeePerGas,
    gasCost,
    priorityFeeScaler: gasPricing.priorityFeeScaler,
    maxFeePerGasScaler: gasPricing.maxFeePerGasScaler,
  };
}

async function simulateDepositGasLimits(
  depositPlan: DepositExecutionPlan,
  simulateTransaction: typeof willSucceed
): Promise<BigNumber[]> {
  const gasLimits: BigNumber[] = [];

  for (const [stepIndex, step] of depositPlan.steps.entries()) {
    const simulation = await simulateTransaction(step.transaction);
    if (simulation.succeed && simulation.transaction.gasLimit) {
      gasLimits.push(simulation.transaction.gasLimit);
      continue;
    }

    const fallbackGasLimit = getApprovalDependentBridgeGasLimitFallback(depositPlan.steps, stepIndex);
    if (fallbackGasLimit) {
      gasLimits.push(fallbackGasLimit);
      continue;
    }

    throw new Error(`Unable to estimate the deposit transaction gas (${simulation.reason ?? "unknown reason"})`);
  }

  return gasLimits;
}

function getApprovalDependentBridgeGasLimitFallback(
  steps: DepositPlanStep[],
  stepIndex: number
): BigNumber | undefined {
  const currentStep = steps[stepIndex];
  const previousStep = stepIndex > 0 ? steps[stepIndex - 1] : undefined;
  if (!currentStep || !previousStep) {
    return undefined;
  }

  if (previousStep.transaction.method !== "approve" || currentStep.transaction.method !== "bridgeWeth") {
    return undefined;
  }

  return APPROVAL_DEPENDENT_BRIDGE_GAS_LIMIT_FALLBACK;
}

function validateQuote(destination: ResolvedBinanceAsset, quote: BinanceQuote): void {
  if (quote.expectedNetDestinationAmount.lte(BigNumber.from(0))) {
    throw new Error("Expected recipient amount is zero after Binance trade and withdrawal fees.");
  }
  const withdrawMin = toBNWei(
    truncate(Number(destination.network.withdrawMin), destination.tokenDecimals),
    destination.tokenDecimals
  );
  const amountToWithdraw = quote.expectedDestinationAmount.sub(quote.tradeFeeDestinationToken);
  if (amountToWithdraw.lt(withdrawMin)) {
    throw new Error(
      `Expected withdrawal amount ${formatAmount(
        amountToWithdraw,
        destination.tokenDecimals
      )} ${destination.tokenSymbol} is below Binance minimum withdrawal size ${formatAmount(withdrawMin, destination.tokenDecimals)} ${destination.tokenSymbol}.`
    );
  }
  const withdrawMax = toBNWei(
    truncate(Number(destination.network.withdrawMax), destination.tokenDecimals),
    destination.tokenDecimals
  );
  if (amountToWithdraw.gt(withdrawMax)) {
    throw new Error(
      `Expected withdrawal amount ${formatAmount(
        amountToWithdraw,
        destination.tokenDecimals
      )} ${destination.tokenSymbol} exceeds Binance maximum withdrawal size ${formatAmount(withdrawMax, destination.tokenDecimals)} ${destination.tokenSymbol}.`
    );
  }
}

function printPreflightSummary(params: {
  signerAddress: string;
  recipient: string;
  source: ResolvedBinanceAsset;
  destination: ResolvedBinanceAsset;
  amount: BigNumber;
  balances: PreflightBalances;
  recipientBalances: RecipientBalances;
  quote: BinanceQuote;
  depositGasEstimate: DepositGasEstimate;
  withdrawalQuotaUsed: number;
  withdrawalQuotaTotal: number;
}): void {
  const { source, destination, amount, balances, recipientBalances, quote, depositGasEstimate } = params;
  const grossDestinationPerSource =
    Number(fromWei(quote.expectedDestinationAmount, destination.tokenDecimals)) /
    Number(fromWei(amount, source.tokenDecimals));
  const netDestinationPerSource =
    Number(fromWei(quote.expectedNetDestinationAmount, destination.tokenDecimals)) /
    Number(fromWei(amount, source.tokenDecimals));
  const grossSourcePerDestination = grossDestinationPerSource > 0 ? 1 / grossDestinationPerSource : 0;
  const nativeToken = getNativeTokenInfoForChain(source.chainId).symbol;
  printSection("Quote");
  printQuoteLine("Account", params.signerAddress);
  printQuoteLine("Source", `${source.tokenSymbol} on ${getNetworkName(source.chainId)} (${source.chainId})`);
  printQuoteLine(
    "Destination",
    `${destination.tokenSymbol} on ${getNetworkName(destination.chainId)} (${destination.chainId})`
  );
  printQuoteLine("Recipient", params.recipient);
  printQuoteLine("Input amount", `${formatAmount(amount, source.tokenDecimals)} ${source.tokenSymbol}`);
  console.log("");
  console.log("Current source-chain balances:");
  printQuoteLine(
    source.isNativeAsset ? "Balance available for deposit" : "Source token balance",
    `${formatAmount(balances.sourceBalance, source.tokenDecimals)} ${source.tokenSymbol}`,
    1
  );
  printQuoteLine(
    "Native balance for gas",
    `${formatAmount(balances.nativeBalance, getNativeTokenInfoForChain(source.chainId).decimals)} ${nativeToken}`,
    1
  );
  console.log("");
  console.log("Current destination recipient balances:");
  printQuoteLine(
    "Destination token balance",
    `${formatAmount(recipientBalances.destinationTokenBalance, destination.tokenDecimals)} ${destination.tokenSymbol}`,
    1
  );
  if (!destination.isNativeAsset) {
    printQuoteLine(
      "Native balance for gas",
      `${formatAmount(recipientBalances.nativeBalance, getNativeTokenInfoForChain(destination.chainId).decimals)} ${getNativeTokenInfoForChain(destination.chainId).symbol}`,
      1
    );
  }
  console.log("");
  printQuoteLine(
    "Expected recipient amount",
    `${formatAmount(quote.expectedNetDestinationAmount, destination.tokenDecimals)} ${destination.tokenSymbol}`
  );
  printQuoteLine(
    "Estimated Binance withdrawal request amount",
    `${formatAmount(quote.expectedDestinationAmount, destination.tokenDecimals)} ${destination.tokenSymbol}`,
    1
  );
  console.log("");
  printQuoteLine(
    "Estimated gross swap rate",
    `${grossDestinationPerSource.toFixed(8)} ${destination.tokenSymbol}/${source.tokenSymbol}`
  );
  printQuoteLine(
    "Inverse gross swap rate",
    `${grossSourcePerDestination.toFixed(8)} ${source.tokenSymbol}/${destination.tokenSymbol}`,
    1
  );
  printQuoteLine(
    "Net recipient rate",
    `${netDestinationPerSource.toFixed(8)} ${destination.tokenSymbol}/${source.tokenSymbol}`,
    1
  );
  console.log("");
  printQuoteLine(
    "Total exchange fee",
    `${formatAmount(quote.totalFeeSourceToken, source.tokenDecimals)} ${source.tokenSymbol}`
  );
  printQuoteLine(
    "Trade fee",
    `${formatAmount(quote.tradeFeeSourceToken, source.tokenDecimals)} ${source.tokenSymbol}`,
    1
  );
  printQuoteLine(
    "Slippage fee",
    `${formatAmount(quote.slippageFeeSourceToken, source.tokenDecimals)} ${source.tokenSymbol}`,
    1
  );
  printQuoteLine(
    "Withdrawal fee",
    `${formatAmount(quote.withdrawalFeeDestinationToken, destination.tokenDecimals)} ${destination.tokenSymbol} (${formatAmount(
      quote.withdrawalFeeSourceToken,
      source.tokenDecimals
    )} ${source.tokenSymbol} source-equivalent)`,
    1
  );
  console.log("");
  printQuoteLine(
    "Estimated deposit gas cost",
    `${formatAmount(depositGasEstimate.gasCost, getNativeTokenInfoForChain(source.chainId).decimals)} ${nativeToken}`
  );
  printQuoteLine("Max fee per gas", `${formatGwei(depositGasEstimate.gasPrice.toString())} gwei`, 1);
  printQuoteLine(
    "Max priority fee per gas",
    `${formatGwei(depositGasEstimate.maxPriorityFeePerGas.toString())} gwei`,
    1
  );
  printQuoteLine("Gas limit", depositGasEstimate.gasLimit.toString(), 1);
  printQuoteLine(
    "Gas scalers",
    `priorityFeeScaler=${depositGasEstimate.priorityFeeScaler} maxFeePerGasScaler=${depositGasEstimate.maxFeePerGasScaler}`,
    1
  );
  console.log("");
  printQuoteLine(
    "Withdrawal quota used",
    `${params.withdrawalQuotaUsed}/${params.withdrawalQuotaTotal} (${(
      (params.withdrawalQuotaUsed / params.withdrawalQuotaTotal) *
      100
    ).toFixed(2)}%)`
  );
  console.log("");
  console.log(boldText("Summary:"));
  printQuoteLine(
    "Expected recipient amount",
    `${formatAmount(quote.expectedNetDestinationAmount, destination.tokenDecimals)} ${destination.tokenSymbol}`,
    1,
    true
  );
  printQuoteLine(
    "Estimated deposit gas cost",
    `${formatAmount(depositGasEstimate.gasCost, getNativeTokenInfoForChain(source.chainId).decimals)} ${nativeToken}`,
    1,
    true
  );
  console.log("");
  console.log("Execution steps:");
  if (source.isNativeAsset) {
    console.log(
      `1. Approve the AtomicWethDepositor if needed, then deposit ${source.tokenSymbol} into Binance via the AtomicWethDepositor on ${getNetworkName(
        source.chainId
      )}.`
    );
  } else {
    console.log(`1. Send the source asset on ${getNetworkName(source.chainId)} into Binance.`);
  }
  console.log("2. Poll Binance until the deposited balance is free to trade.");
  console.log("3. Place a Binance spot market order.");
  console.log(`4. Request the withdrawal to ${getNetworkName(destination.chainId)} and wait for Binance completion.`);
}

function buildAssetResolutionError(
  side: "source" | "destination",
  tokenSymbol: string,
  chainId: number,
  direction: "deposit" | "withdraw",
  accountCoins: Coin[],
  reason: BinanceAssetResolutionFailureReason
): string {
  const title = `${capitalize(side)} token ${tokenSymbol} on ${getNetworkName(chainId)} (${chainId}) is not usable for Binance ${direction}.`;
  switch (reason) {
    case "UNKNOWN_TOKEN":
      return `${title}\nEligible known tokens on this chain: ${getEligibleKnownTokensForChain(accountCoins, chainId, direction).join(", ") || "none"}`;
    case "UNSUPPORTED_CHAIN":
      return `${title}\nAvailable chains for ${tokenSymbol}: ${formatChainList(getAvailableChainsForToken(accountCoins, tokenSymbol, direction)) || "none"}`;
    case "CONTRACT_ADDRESS_MISMATCH":
      return `${title}\nBinance exposes a network for ${tokenSymbol}, but its contract address does not match the token address configured in this repo on chain ${chainId}.`;
    case "NATIVE_SOURCE_ATOMIC_DEPOSITOR_REQUIRED":
      return `${title}\nNative-asset source deposits require an AtomicWethDepositor deployment and transfer proxy on ${getNetworkName(
        chainId
      )}.`;
    case "DEPOSIT_DISABLED":
      return `${title}\nBinance currently reports deposits disabled for this network.`;
    case "WITHDRAW_DISABLED":
      return `${title}\nBinance currently reports withdrawals disabled for this network.`;
    case "MEMO_REQUIRED":
      return `${title}\nThis Binance network requires a memo/tag or other extra withdrawal fields. This script only supports plain-address withdrawals.`;
    default:
      return title;
  }
}

function describeBinanceWithdrawalStatus(status?: number): string {
  switch (status) {
    case BINANCE_WITHDRAWAL_STATUS.EMAIL_SENT:
      return "email-sent";
    case BINANCE_WITHDRAWAL_STATUS.CANCELLED:
      return "cancelled";
    case BINANCE_WITHDRAWAL_STATUS.AWAITING_APPROVAL:
      return "awaiting-approval";
    case BINANCE_WITHDRAWAL_STATUS.REJECTED:
      return "rejected";
    case BINANCE_WITHDRAWAL_STATUS.PROCESSING:
      return "processing";
    case BINANCE_WITHDRAWAL_STATUS.FAILURE:
      return "failure";
    case BINANCE_WITHDRAWAL_STATUS.COMPLETED:
      return "completed";
    default:
      return "unknown";
  }
}

function parseAmount(amount: string, decimals: number): BigNumber {
  try {
    return parseUnits(amount, decimals);
  } catch (error) {
    throw new Error(`Invalid amount ${amount} for token decimals ${decimals}: ${String(error)}`);
  }
}

function requiredStringFlag(args: ParsedSwapArgs, flag: string): string {
  const value = args[flag];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required flag --${flag}`);
  }
  return value.trim();
}

function requiredChainFlag(args: ParsedSwapArgs, flag: string): number {
  const value = Number(requiredStringFlag(args, flag));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Flag --${flag} must be a positive integer chain id`);
  }
  return value;
}

function assertExplicitWalletFlag(normalizedArgv: string[]): void {
  const hasWalletFlag = normalizedArgv.some((arg) => arg === "--wallet" || arg.startsWith("--wallet="));
  if (!hasWalletFlag) {
    throw new Error("Explicit --wallet is required for this script.");
  }
}

function parseCliArgs(argv = process.argv.slice(2)): { args: ParsedSwapArgs; normalizedArgv: string[] } {
  const normalizedArgv = normalizeLongFlags(argv);
  const args = minimist(normalizedArgv, {
    string: [
      "srcToken",
      "srcChain",
      "dstToken",
      "dstChain",
      "amount",
      "recipient",
      "wallet",
      "keys",
      "binanceSecretKey",
      "priorityFeeScaler",
      "maxFeePerGasScaler",
    ],
  });
  return { args, normalizedArgv };
}

function optionalNumberFlag(args: ParsedSwapArgs, flag: string, defaultValue: number): number {
  const rawValue = args[flag];
  if (!isDefined(rawValue)) {
    return defaultValue;
  }
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`Flag --${flag} must be a finite number greater than or equal to 1`);
  }
  return value;
}

function normalizeLongFlags(argv: string[]): string[] {
  return argv.map((arg) => {
    if (arg.startsWith("--")) {
      return arg;
    }
    if (/^-[A-Za-z][A-Za-z0-9]*(=.*)?$/.test(arg)) {
      return `-${arg}`;
    }
    return arg;
  });
}

function printSection(title: string): void {
  console.log(`\n=== ${title} ===\n`);
}

export function formatWithdrawalProgressLine(params: {
  attempts: number;
  elapsedMs: number;
  withdrawal?: BinanceWithdrawal;
}): string {
  const status = params.withdrawal ? readableBinanceWithdrawalStatus(params.withdrawal.status) : "not-seen";
  const amount = params.withdrawal ? params.withdrawal.amount : "unknown";
  const txIdSuffix = params.withdrawal?.txId ? ` txId=${params.withdrawal.txId}` : "";
  return `[poll ${params.attempts}, elapsed: ${Math.round(params.elapsedMs / 1000)}s] withdrawal=${status} amount=${amount}${txIdSuffix}`;
}

export function requireDefinedFilledAmount(
  expectedFilledAmount: number | undefined,
  orderId: string,
  binanceCoin: string
): number {
  assert(
    isDefined(expectedFilledAmount),
    `Filled amount for Binance order ${orderId} (${binanceCoin}) is not available yet from Binance order history`
  );
  return expectedFilledAmount;
}

function formatAmount(amount: BigNumber, decimals: number): string {
  return createFormatFunction(2, 6, false, decimals)(amount.toString());
}

function printQuoteLine(label: string, value: string, indentLevel = 0, emphasized = false): void {
  const line = `${"\t".repeat(indentLevel)}${label}: ${value}`;
  console.log(emphasized ? boldText(line) : line);
}

function boldText(text: string): string {
  return `\u001b[1m${text}\u001b[0m`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function isValidRecipientForChain(recipient: string, chainId: number): boolean {
  try {
    if (chainIsTvm(chainId) && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(recipient)) {
      return false;
    }
    return toAddressType(recipient, chainId).isValidOn(chainId);
  } catch {
    return false;
  }
}

function getEligibleKnownTokensForChain(
  accountCoins: Coin[],
  chainId: number,
  direction: "deposit" | "withdraw"
): string[] {
  const tokens = new Set<string>();

  for (const symbol of Object.keys(TOKEN_SYMBOLS_MAP)) {
    const resolution = resolveBinanceAsset({
      accountCoins,
      tokenSymbol: symbol,
      chainId,
      direction,
    });
    if (resolution.ok) {
      tokens.add(symbol);
    }
  }

  return Array.from(tokens).sort();
}

function getAvailableChainsForToken(
  accountCoins: Coin[],
  tokenSymbol: string,
  direction: "deposit" | "withdraw"
): number[] {
  const normalizedSymbol = tokenSymbol.trim().toUpperCase();

  return Object.keys(BINANCE_NETWORKS)
    .map(Number)
    .filter(
      (chainId) =>
        resolveBinanceAsset({
          accountCoins,
          tokenSymbol: normalizedSymbol,
          chainId,
          direction,
        }).ok
    )
    .sort((a, b) => a - b);
}

function formatChainList(chainIds: number[]): string {
  return chainIds.map((chainId) => `${getNetworkName(chainId)} (${chainId})`).join(", ");
}

function tryGetTokenAddressForL1TokenSymbol(tokenSymbol: string, chainId: number): string | undefined {
  try {
    return getTokenInfoFromSymbol(tokenSymbol, chainId).address.toNative();
  } catch (_e) {
    return resolveAcrossToken(tokenSymbol, chainId);
  }
}

export function resolveBinanceAsset(params: {
  accountCoins: Coin[];
  tokenSymbol: string;
  chainId: number;
  direction: "deposit" | "withdraw";
}): BinanceAssetResolutionResult {
  const { accountCoins, chainId, direction } = params;
  const tokenSymbol = params.tokenSymbol.trim().toUpperCase();
  const isNativeToken = tokenSymbol === getNativeTokenInfoForChain(chainId).symbol.toUpperCase();
  const localTokenAddress = isNativeToken ? undefined : tryGetTokenAddressForL1TokenSymbol(tokenSymbol, chainId);

  const depositMode: BinanceSourceDepositMode | undefined =
    direction === "deposit" ? (isNativeToken ? "native" : "erc20") : undefined;

  if (isNativeToken) {
    const matchingCoin = accountCoins.find(
      (coin) => coin.symbol === resolveBinanceCoinSymbol(getNativeTokenInfoForChain(chainId).symbol)
    );
    const matchingNetwork = matchingCoin?.networkList.find((network) => networkMatchesChain(network.name, chainId));

    if (!matchingCoin || !matchingNetwork) {
      return { ok: false, reason: "UNSUPPORTED_CHAIN" };
    }
    if (!isNetworkEnabledForDirection(matchingNetwork, direction)) {
      return { ok: false, reason: direction === "deposit" ? "DEPOSIT_DISABLED" : "WITHDRAW_DISABLED" };
    }
    if (direction === "deposit" && !isDefined(getAtomicDepositorContracts(chainId))) {
      return { ok: false, reason: "NATIVE_SOURCE_ATOMIC_DEPOSITOR_REQUIRED" };
    }
    if (direction === "withdraw" && networkRequiresMemo(matchingNetwork)) {
      return { ok: false, reason: "MEMO_REQUIRED" };
    }

    return {
      ok: true,
      asset: {
        tokenSymbol,
        chainId,
        binanceCoin: matchingCoin.symbol,
        network: matchingNetwork,
        tokenDecimals: getNativeTokenInfoForChain(chainId).decimals,
        isNativeAsset: depositMode === "native" || direction === "withdraw",
        depositMode,
      },
    };
  }

  if (!isDefined(localTokenAddress)) {
    return isKnownTokenSymbol(tokenSymbol)
      ? { ok: false, reason: "UNSUPPORTED_CHAIN" }
      : { ok: false, reason: "UNKNOWN_TOKEN" };
  }

  const binanceCoin = resolveBinanceCoinSymbol(tokenSymbol);
  const matchingCoin = accountCoins.find((coin) => coin.symbol === binanceCoin);
  if (!matchingCoin) {
    return { ok: false, reason: "UNKNOWN_TOKEN" };
  }

  const chainNetworks = matchingCoin.networkList.filter((network) => networkMatchesChain(network.name, chainId));
  if (chainNetworks.length === 0) {
    return { ok: false, reason: "UNSUPPORTED_CHAIN" };
  }

  const matchingNetwork = chainNetworks.find((network) =>
    contractAddressMatchesToken(chainId, localTokenAddress, network.contractAddress)
  );
  if (!matchingNetwork) {
    return { ok: false, reason: "CONTRACT_ADDRESS_MISMATCH" };
  }
  if (!isNetworkEnabledForDirection(matchingNetwork, direction)) {
    return { ok: false, reason: direction === "deposit" ? "DEPOSIT_DISABLED" : "WITHDRAW_DISABLED" };
  }
  if (direction === "withdraw" && networkRequiresMemo(matchingNetwork)) {
    return { ok: false, reason: "MEMO_REQUIRED" };
  }

  return {
    ok: true,
    asset: {
      tokenSymbol,
      chainId,
      binanceCoin: matchingCoin.symbol,
      network: matchingNetwork,
      tokenDecimals: getTokenInfoFromSymbol(tokenSymbol, chainId).decimals,
      isNativeAsset: false,
      localTokenAddress,
      depositMode,
    },
  };
}

export class BinanceSwapVenue {
  private exchangeInfo?: Awaited<ReturnType<Binance["exchangeInfo"]>>;
  private tradeFees?: Awaited<ReturnType<Binance["tradeFee"]>>;
  private orderBookBySymbol = new Map<string, Awaited<ReturnType<Binance["book"]>>>();

  constructor(private readonly binanceApiClient: Binance) {}

  rawApi(): Binance {
    return this.binanceApiClient;
  }

  async getSpotFreeBalance(binanceCoin: string): Promise<number> {
    const accountInfo = await this.binanceApiClient.accountInfo();
    const balance = accountInfo.balances.find((candidate) => resolveBinanceCoinSymbol(candidate.asset) === binanceCoin);
    return Number(balance?.free ?? "0");
  }

  async getExchangeInfo(): Promise<Awaited<ReturnType<Binance["exchangeInfo"]>>> {
    if (!this.exchangeInfo) {
      this.exchangeInfo = await this.binanceApiClient.exchangeInfo();
    }
    return this.exchangeInfo;
  }

  async getTradeFees(): Promise<Awaited<ReturnType<Binance["tradeFee"]>>> {
    if (!this.tradeFees) {
      this.tradeFees = await this.binanceApiClient.tradeFee();
    }
    return this.tradeFees;
  }

  async getSymbol(sourceBinanceCoin: string, destinationBinanceCoin: string) {
    const exchangeInfo = await this.getExchangeInfo();
    const symbol = exchangeInfo.symbols.find(
      (candidate) =>
        candidate.symbol === `${sourceBinanceCoin}${destinationBinanceCoin}` ||
        candidate.symbol === `${destinationBinanceCoin}${sourceBinanceCoin}`
    );
    assert(isDefined(symbol), `No Binance market found for ${sourceBinanceCoin}-${destinationBinanceCoin}`);
    return symbol;
  }

  async getSpotMarketMeta(sourceBinanceCoin: string, destinationBinanceCoin: string): Promise<SpotMarketMeta> {
    const symbol = await this.getSymbol(sourceBinanceCoin, destinationBinanceCoin);
    return deriveBinanceSpotMarketMeta(sourceBinanceCoin, destinationBinanceCoin, symbol);
  }

  async getOrderBook(symbol: string): Promise<Awaited<ReturnType<Binance["book"]>>> {
    const cachedBook = this.orderBookBySymbol.get(symbol);
    if (cachedBook) {
      return cachedBook;
    }

    const book = await this.fetchOrderBook(symbol);
    this.orderBookBySymbol.set(symbol, book);
    return book;
  }

  async fetchOrderBook(symbol: string, nRetries = 0, maxRetries = 3): Promise<Awaited<ReturnType<Binance["book"]>>> {
    try {
      return await this.binanceApiClient.book({ symbol, limit: 5000 });
    } catch (error) {
      if (nRetries >= maxRetries) {
        throw error;
      }
      await sleepMs((2 ** nRetries + Math.random()) * 1000);
      return this.fetchOrderBook(symbol, nRetries + 1, maxRetries);
    }
  }

  async getLatestPrice(
    sourceBinanceCoin: string,
    destinationBinanceCoin: string,
    sourceTokenDecimals: number,
    sourceAmount: BigNumber
  ): Promise<{ latestPrice: number; slippagePct: number }> {
    if (sourceBinanceCoin === destinationBinanceCoin) {
      return { latestPrice: 1, slippagePct: 0 };
    }

    const symbol = await this.getSymbol(sourceBinanceCoin, destinationBinanceCoin);
    const book = await this.getOrderBook(symbol.symbol);
    const spotMarketMeta = await this.getSpotMarketMeta(sourceBinanceCoin, destinationBinanceCoin);
    const sideOfBookToTraverse = spotMarketMeta.isBuy ? book.asks : book.bids;
    assert(sideOfBookToTraverse.length > 0, `Order book is empty for ${symbol.symbol}`);

    const bestPx = Number(sideOfBookToTraverse[0].price);
    let visibleDepth = BigNumber.from(0);
    const terminalLevel = sideOfBookToTraverse.find((level) => {
      const levelSize = spotMarketMeta.isBuy ? Number(level.quantity) * Number(level.price) : Number(level.quantity);
      const levelSizeWei = toBNWei(truncate(levelSize, sourceTokenDecimals), sourceTokenDecimals);
      if (visibleDepth.add(levelSizeWei).gte(sourceAmount)) {
        return true;
      }
      visibleDepth = visibleDepth.add(levelSizeWei);
      return false;
    });

    if (!terminalLevel) {
      throw new Error(
        `Order size ${sourceAmount.toString()} exceeds visible Binance order book depth ${visibleDepth.toString()}, reduce amountToTransfer`
      );
    }

    const latestPrice = Number(Number(terminalLevel.price).toFixed(spotMarketMeta.pxDecimals));
    const slippagePct = Math.abs((latestPrice - bestPx) / bestPx) * 100;
    return { latestPrice, slippagePct };
  }

  async convertSourceToDestination(
    source: ResolvedBinanceAsset,
    destination: ResolvedBinanceAsset,
    sourceAmount: BigNumber
  ): Promise<BigNumber> {
    if (source.binanceCoin === destination.binanceCoin) {
      return ConvertDecimals(source.tokenDecimals, destination.tokenDecimals)(sourceAmount);
    }

    const spotMarketMeta = await this.getSpotMarketMeta(source.binanceCoin, destination.binanceCoin);
    const price = await this.getLatestPrice(
      source.binanceCoin,
      destination.binanceCoin,
      source.tokenDecimals,
      sourceAmount
    );
    return convertBinanceRouteAmount({
      amount: sourceAmount,
      sourceTokenDecimals: source.tokenDecimals,
      destinationTokenDecimals: destination.tokenDecimals,
      isBuy: spotMarketMeta.isBuy,
      price: price.latestPrice,
      direction: "source-to-destination",
    });
  }

  async convertDestinationToSource(
    source: ResolvedBinanceAsset,
    destination: ResolvedBinanceAsset,
    destinationAmount: BigNumber
  ): Promise<BigNumber> {
    if (source.binanceCoin === destination.binanceCoin) {
      return ConvertDecimals(destination.tokenDecimals, source.tokenDecimals)(destinationAmount);
    }

    const spotMarketMeta = await this.getSpotMarketMeta(source.binanceCoin, destination.binanceCoin);
    const destinationAmountInSourcePrecision = ConvertDecimals(
      destination.tokenDecimals,
      source.tokenDecimals
    )(destinationAmount);
    const price = await this.getLatestPrice(
      source.binanceCoin,
      destination.binanceCoin,
      source.tokenDecimals,
      destinationAmountInSourcePrecision
    );
    return convertBinanceRouteAmount({
      amount: destinationAmount,
      sourceTokenDecimals: source.tokenDecimals,
      destinationTokenDecimals: destination.tokenDecimals,
      isBuy: spotMarketMeta.isBuy,
      price: price.latestPrice,
      direction: "destination-to-source",
    });
  }

  async getQuote(
    source: ResolvedBinanceAsset,
    destination: ResolvedBinanceAsset,
    sourceAmount: BigNumber
  ): Promise<BinanceQuote> {
    assert(
      source.binanceCoin !== destination.binanceCoin,
      `This script only supports swap routes. ${source.binanceCoin}-${destination.binanceCoin} does not require a Binance market order.`
    );
    const price = await this.getLatestPrice(
      source.binanceCoin,
      destination.binanceCoin,
      source.tokenDecimals,
      sourceAmount
    );
    const spotMarketMeta = await this.getSpotMarketMeta(source.binanceCoin, destination.binanceCoin);
    const tradeFeePct = await this.getTradeFeePct(spotMarketMeta.symbol);
    const tradeFeeSourceToken = toBNWei(truncate(tradeFeePct, 18), 18).mul(sourceAmount).div(toBNWei(1, 18));
    const tradeFeeDestinationToken = tradeFeeSourceToken.gt(BigNumber.from(0))
      ? await this.convertSourceToDestination(source, destination, tradeFeeSourceToken)
      : BigNumber.from(0);
    const slippageFeeSourceToken = toBNWei(truncate(price.slippagePct, 18), 18).mul(sourceAmount).div(toBNWei(1, 20));
    const withdrawalFeeDestinationToken = toBNWei(
      truncate(Number(destination.network.withdrawFee), destination.tokenDecimals),
      destination.tokenDecimals
    );
    const withdrawalFeeSourceToken = await this.convertDestinationToSource(
      source,
      destination,
      withdrawalFeeDestinationToken
    );
    const expectedDestinationAmount = await this.convertSourceToDestination(source, destination, sourceAmount);
    const totalDestinationFees = tradeFeeDestinationToken.add(withdrawalFeeDestinationToken);
    const expectedNetDestinationAmount = expectedDestinationAmount.gt(totalDestinationFees)
      ? expectedDestinationAmount.sub(totalDestinationFees)
      : BigNumber.from(0);

    return {
      spotMarketMeta,
      latestPrice: price.latestPrice,
      slippagePct: price.slippagePct,
      tradeFeePct,
      tradeFeeSourceToken,
      tradeFeeDestinationToken,
      slippageFeeSourceToken,
      withdrawalFeeDestinationToken,
      withdrawalFeeSourceToken,
      totalFeeSourceToken: tradeFeeSourceToken.add(slippageFeeSourceToken).add(withdrawalFeeSourceToken),
      expectedDestinationAmount,
      expectedNetDestinationAmount,
    };
  }

  async getQuantityForOrder(
    source: ResolvedBinanceAsset,
    destination: ResolvedBinanceAsset,
    sourceAmount: BigNumber
  ): Promise<number> {
    const spotMarketMeta = await this.getSpotMarketMeta(source.binanceCoin, destination.binanceCoin);
    const amountToOrder = spotMarketMeta.isBuy
      ? await this.convertSourceToDestination(source, destination, sourceAmount)
      : sourceAmount;
    const orderDecimals = spotMarketMeta.isBuy ? destination.tokenDecimals : source.tokenDecimals;
    const size = truncate(Number(fromWei(amountToOrder, orderDecimals)), spotMarketMeta.szDecimals);
    assert(
      size >= spotMarketMeta.minimumOrderSize,
      `size of order ${size} is less than minimum order size ${spotMarketMeta.minimumOrderSize}`
    );
    return size;
  }

  async placeMarketOrder(
    cloid: string,
    source: ResolvedBinanceAsset,
    destination: ResolvedBinanceAsset,
    sourceAmount: BigNumber
  ): Promise<Awaited<ReturnType<Binance["order"]>>> {
    const spotMarketMeta = await this.getSpotMarketMeta(source.binanceCoin, destination.binanceCoin);
    const quantity = await this.getQuantityForOrder(source, destination, sourceAmount);
    const response = await this.binanceApiClient.order({
      symbol: spotMarketMeta.symbol,
      newClientOrderId: cloid,
      side: spotMarketMeta.isBuy ? "BUY" : "SELL",
      type: OrderType.MARKET,
      quantity: quantity.toString(),
      recvWindow: 60_000,
    } as NewOrderSpot);
    assert(response.status === "FILLED", `Market order was not filled: ${JSON.stringify(response)}`);
    return response;
  }

  async getExpectedAmountToReceiveForFilledOrder(
    fillOrderId: number,
    cloid: string,
    source: ResolvedBinanceAsset,
    destination: ResolvedBinanceAsset
  ): Promise<number | undefined> {
    const spotMarketMeta = await this.getSpotMarketMeta(source.binanceCoin, destination.binanceCoin);
    const allOrders = await this.binanceApiClient.allOrders({
      orderId: fillOrderId,
      symbol: spotMarketMeta.symbol,
    });
    const matchingFill = allOrders.find((order) => order.clientOrderId === cloid && order.status === "FILLED");
    if (!matchingFill) {
      return undefined;
    }
    const totalCommission = await getFillCommission(this.binanceApiClient, spotMarketMeta, matchingFill.orderId);
    const expectedAmountToReceive =
      matchingFill.side === "BUY" ? matchingFill.executedQty : matchingFill.cummulativeQuoteQty;
    return Number(expectedAmountToReceive) - totalCommission;
  }

  private async getTradeFeePct(symbol: string): Promise<number> {
    const tradeFee = (await this.getTradeFees()).find((fee) => fee.symbol === symbol)?.takerCommission;
    assert(isDefined(tradeFee), `Trade fee percentage not found for symbol ${symbol}`);
    const tradeFeePct = Number(tradeFee);
    assert(Number.isFinite(tradeFeePct), `Trade fee percentage for symbol ${symbol} is not a finite number`);
    return tradeFeePct;
  }

  async getMatchingFillForCloid(
    cloid: string,
    source: ResolvedBinanceAsset,
    destination: ResolvedBinanceAsset
  ): Promise<{ matchingFill: QueryOrderResult; expectedAmountToReceive: string } | undefined> {
    const spotMarketMeta = await this.getSpotMarketMeta(source.binanceCoin, destination.binanceCoin);
    const allOrders = await this.binanceApiClient.allOrders({ symbol: spotMarketMeta.symbol });
    const matchingFill = allOrders.find((order) => order.clientOrderId === cloid && order.status === "FILLED");
    if (!matchingFill) {
      return undefined;
    }
    const totalCommission = await getFillCommission(this.binanceApiClient, spotMarketMeta, matchingFill.orderId);
    const grossExpectedAmountToReceive = spotMarketMeta.isBuy
      ? Number(matchingFill.executedQty)
      : Number(matchingFill.cummulativeQuoteQty);
    return { matchingFill, expectedAmountToReceive: String(grossExpectedAmountToReceive - totalCommission) };
  }

  async initiateWithdrawal(destination: ResolvedBinanceAsset, recipient: string, amount: BigNumber): Promise<string> {
    const amountReadable = Number(fromWei(amount, destination.tokenDecimals));
    const withdrawalAmount = truncate(amountReadable, destination.tokenDecimals);
    const response = await this.binanceApiClient.withdraw({
      coin: destination.binanceCoin,
      address: recipient,
      amount: withdrawalAmount,
      network: destination.network.name,
      transactionFeeFlag: false,
    });
    return response.id;
  }
}

export async function waitForBinanceDepositToBeAvailable(params: {
  venue: BinanceSwapVenue;
  source: ResolvedBinanceAsset;
  depositTxHash: string;
  minFreeBalance: number;
  startTimeMs: number;
  pollDelayMs?: number;
  onProgress?: (update: { attempts: number; deposit?: BinanceDeposit; freeBalance: number }) => void;
}): Promise<BinanceDepositAvailability> {
  const { venue, source, depositTxHash, minFreeBalance, startTimeMs } = params;
  const pollDelayMs = params.pollDelayMs ?? POLL_DELAY_MS;
  let attempts = 0;

  for (;;) {
    attempts++;
    const [deposits, freeBalance] = await Promise.all([
      getBinanceDeposits(venue.rawApi(), startTimeMs),
      venue.getSpotFreeBalance(source.binanceCoin),
    ]);
    const matchingDeposit = deposits.find(
      (deposit) =>
        deposit.coin === source.binanceCoin &&
        deposit.network === source.network.name &&
        compareAddressesSimple(deposit.txId, depositTxHash)
    );

    if (
      matchingDeposit?.status === BinanceDepositStatus.Rejected ||
      matchingDeposit?.status === BinanceDepositStatus.WrongDeposit
    ) {
      throw new Error(
        `Binance rejected the deposit ${depositTxHash} with status ${describeBinanceDepositStatus(matchingDeposit.status)}`
      );
    }
    if (matchingDeposit?.status === BinanceDepositStatus.WaitingUserConfirm) {
      throw new Error(`Binance deposit ${depositTxHash} is waiting for user confirmation on Binance`);
    }

    params.onProgress?.({ attempts, deposit: matchingDeposit, freeBalance });

    if (freeBalance >= minFreeBalance) {
      return { attempts, deposit: matchingDeposit, freeBalance };
    }
    await sleepMs(pollDelayMs);
  }
}

export async function waitForBinanceOrderFillAndBalance(params: {
  venue: BinanceSwapVenue;
  cloid: string;
  source: ResolvedBinanceAsset;
  destination: ResolvedBinanceAsset;
  requiredBalance?: number;
  pollDelayMs?: number;
  onProgress?: (update: {
    attempts: number;
    freeBalance: number;
    requiredBalance?: number;
    matchingFill?: QueryOrderResult;
  }) => void;
}): Promise<BinanceOrderFillAvailability> {
  const pollDelayMs = params.pollDelayMs ?? POLL_DELAY_MS;
  let attempts = 0;

  for (;;) {
    attempts++;
    const [matchingFill, freeBalance] = await Promise.all([
      params.venue.getMatchingFillForCloid(params.cloid, params.source, params.destination),
      params.venue.getSpotFreeBalance(params.destination.binanceCoin),
    ]);
    const requiredBalance =
      params.requiredBalance ??
      (matchingFill
        ? truncate(Number(matchingFill.expectedAmountToReceive), params.destination.tokenDecimals)
        : undefined);
    params.onProgress?.({
      attempts,
      freeBalance,
      matchingFill: matchingFill?.matchingFill,
      requiredBalance,
    });

    if (matchingFill && isDefined(requiredBalance) && freeBalance >= requiredBalance) {
      return {
        attempts,
        freeBalance,
        matchingFill: matchingFill.matchingFill,
        expectedAmountToReceive: matchingFill.expectedAmountToReceive,
      };
    }

    await sleepMs(pollDelayMs);
  }
}

export async function waitForBinanceWithdrawalCompletion(params: {
  venue: BinanceSwapVenue;
  destination: ResolvedBinanceAsset;
  withdrawalId: string;
  startTimeMs: number;
  pollDelayMs?: number;
  onProgress?: (update: { attempts: number; withdrawal?: BinanceWithdrawal }) => void;
}): Promise<BinanceWithdrawalCompletion> {
  const pollDelayMs = params.pollDelayMs ?? POLL_DELAY_MS;
  let attempts = 0;

  for (;;) {
    attempts++;
    const withdrawals = await getBinanceWithdrawals(
      params.venue.rawApi(),
      params.destination.binanceCoin,
      params.startTimeMs
    );
    const withdrawal = withdrawals.find((candidate) => candidate.id === params.withdrawalId);
    params.onProgress?.({ attempts, withdrawal });

    if (withdrawal && isFailedBinanceWithdrawal(withdrawal.status)) {
      throw new Error(
        `Binance withdrawal ${params.withdrawalId} failed with status ${describeBinanceWithdrawalStatus(
          withdrawal.status
        )}`
      );
    }
    if (withdrawal?.status === BINANCE_WITHDRAWAL_STATUS.COMPLETED || isDefined(withdrawal?.txId)) {
      return {
        attempts,
        observedCompletedAtMs: Date.now(),
        withdrawal,
      };
    }

    await sleepMs(pollDelayMs);
  }
}

function normalizeNetworkName(networkName: string): string {
  return networkName.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function networkMatchesChain(networkName: string, chainId: number): boolean {
  const normalizedNetworkName = normalizeNetworkName(networkName);
  const expectedNetworkName = BINANCE_NETWORKS[chainId];
  return isDefined(expectedNetworkName) && normalizeNetworkName(expectedNetworkName) === normalizedNetworkName;
}

function contractAddressMatchesToken(
  chainId: number,
  localTokenAddress: string,
  networkContractAddress?: string
): boolean {
  if (!networkContractAddress) {
    return false;
  }
  try {
    const normalizedLocalAddress = getEthersCompatibleAddress(chainId, localTokenAddress).toLowerCase();
    const normalizedNetworkAddress = getEthersCompatibleAddress(chainId, networkContractAddress).toLowerCase();
    return compareAddressesSimple(normalizedLocalAddress, normalizedNetworkAddress);
  } catch {
    return false;
  }
}

function isNetworkEnabledForDirection(network: BinanceAssetNetwork, direction: "deposit" | "withdraw"): boolean {
  if (direction === "deposit") {
    return network.depositEnable ?? true;
  }
  return network.withdrawEnable ?? true;
}

function networkRequiresMemo(network: BinanceAssetNetwork): boolean {
  return network.withdrawTag === true;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeBinanceDepositStatus(status?: number): string {
  switch (status) {
    case BinanceDepositStatus.Pending:
      return "pending";
    case BinanceDepositStatus.Confirmed:
      return "confirmed";
    case BinanceDepositStatus.Rejected:
      return "rejected";
    case BinanceDepositStatus.Credited:
      return "credited";
    case BinanceDepositStatus.WrongDeposit:
      return "wrong-deposit";
    case BinanceDepositStatus.WaitingUserConfirm:
      return "waiting-user-confirm";
    default:
      return "unknown";
  }
}

function formatBinanceDepositPollStatus(deposit?: BinanceDeposit): string {
  if (!deposit) {
    return "not-seen";
  }
  if (!isDefined(deposit.status)) {
    return "unknown";
  }
  return BINANCE_DEPOSIT_STATUS_LABELS[deposit.status] ?? describeBinanceDepositStatus(deposit.status);
}

function isKnownTokenSymbol(symbol: string): boolean {
  return Object.keys(TOKEN_SYMBOLS_MAP).includes(symbol);
}

if (require.main === module) {
  run()
    .then(async () => {
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("Swap failed:");
      console.error(error instanceof Error ? error.message : String(error));
      if (error instanceof Error && error.stack) {
        console.error(error.stack);
      }
      process.exit(1);
    });
}

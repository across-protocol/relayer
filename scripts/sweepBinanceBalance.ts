/*
Usage example:

yarn ts-node ./scripts/sweepBinanceBalance.ts \
  --token TRX \
  --dstChain 728126428 \
  --recipient <DESTINATION_ADDRESS>

Provide Binance credentials through the standard repo auth inputs for your environment.
If your Binance secret is GCKMS-backed, run the script under with-gcp-auth.
*/

import minimist from "minimist";
import winston from "winston";
import { askYesNoQuestion } from "./utils";
import { BinanceClient } from "../src/clients/BinanceClient";
import {
  BINANCE_NETWORKS,
  BinanceWithdrawal,
  BigNumber,
  Coin,
  TOKEN_SYMBOLS_MAP,
  blockExplorerLink,
  chainIsTvm,
  createFormatFunction,
  fromWei,
  getAccountCoins,
  getNetworkName,
  parseUnits,
  resolveBinanceCoinSymbol,
  toAddressType,
  truncate,
  readableBinanceWithdrawalStatus,
} from "../src/utils";
import {
  BinanceSwapVenue,
  ResolvedBinanceAsset,
  resolveBinanceAsset,
  waitForBinanceWithdrawalCompletion,
} from "./swapOnBinance";

type ParsedArgs = minimist.ParsedArgs;

type SweepPlan = {
  freeBalance: BigNumber;
  withdrawalAmount: BigNumber;
  withdrawalFee: BigNumber;
  expectedRecipientAmount: BigNumber;
  residualBalance: BigNumber;
  cappedByWithdrawMax: boolean;
};

async function run(): Promise<void> {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    return;
  }

  const token = requiredStringFlag(args, "token").toUpperCase();
  const dstChain = requiredChainFlag(args, "dstChain");
  const recipient = requiredStringFlag(args, "recipient");

  printSection("Binance Sweep");

  const logger = winston.createLogger({
    level: "info",
    format: winston.format.simple(),
    transports: [new winston.transports.Console()],
  });

  const binanceClient = await BinanceClient.create({ logger, url: process.env["BINANCE_API_BASE"] });
  const venue = new BinanceSwapVenue(binanceClient.rawApi());
  const [accountCoins, withdrawalQuota] = await Promise.all([
    getAccountCoins(binanceClient.rawApi()),
    binanceClient.getWithdrawalLimits(),
  ]);

  const destinationResolution = resolveBinanceAsset({
    accountCoins,
    tokenSymbol: token,
    chainId: dstChain,
    direction: "withdraw",
  });
  if (!destinationResolution.ok) {
    const { reason } = destinationResolution as { ok: false; reason: string };
    throw new Error(buildDestinationResolutionError(token, dstChain, accountCoins, reason));
  }
  const destination = destinationResolution.asset;

  if (!isValidRecipientForChain(recipient, dstChain)) {
    throw new Error(`Recipient ${recipient} is not a valid address on ${getNetworkName(dstChain)} (${dstChain})`);
  }

  const matchingCoin = accountCoins.find((coin) => coin.symbol === destination.binanceCoin);
  const freeBalance = parseCoinBalance(matchingCoin?.balance ?? "0", destination.tokenDecimals);
  const sweepPlan = buildSweepPlan({ destination, freeBalance });

  printSummary({
    token,
    destination,
    recipient,
    sweepPlan,
    withdrawalQuotaUsed: withdrawalQuota.usedWdQuota,
    withdrawalQuotaTotal: withdrawalQuota.wdQuota,
  });

  if (!(await askYesNoQuestion("Proceed with this Binance withdrawal sweep?"))) {
    console.log("Aborted.");
    return;
  }

  printSection("Withdraw");
  console.log(
    `Requesting Binance withdrawal of ${formatAmount(sweepPlan.withdrawalAmount, destination.tokenDecimals)} ${destination.tokenSymbol} to ${recipient} on ${getNetworkName(destination.chainId)}...`
  );

  const withdrawalSubmittedAtMs = Date.now();
  const amountReadable = Number(fromWei(sweepPlan.withdrawalAmount, destination.tokenDecimals));
  const response = await binanceClient.rawApi().withdraw({
    coin: destination.binanceCoin,
    address: recipient,
    amount: truncate(amountReadable, destination.tokenDecimals),
    network: destination.network.name,
    transactionFeeFlag: false,
  });
  const withdrawalId = response.id;
  console.log(`Withdrawal initiated. Binance withdrawal id: ${withdrawalId}`);

  printSection("Wait For Completion");
  const timerStart = Date.now();
  const completion = await waitForBinanceWithdrawalCompletion({
    venue,
    destination,
    withdrawalId,
    startTimeMs: withdrawalSubmittedAtMs - 60_000,
    onProgress(update) {
      const status = update.withdrawal ? describeWithdrawalStatus(update.withdrawal) : "pending-visibility";
      console.log(
        `[poll ${update.attempts}, elapsed: ${Math.round((Date.now() - timerStart) / 1000)}s] Polling Binance withdrawal status: ${status}`
      );
    },
  });

  printSection("Complete");
  printLine("Recipient explorer", blockExplorerLink(recipient, destination.chainId));
  if (completion.withdrawal.txId) {
    printLine("Withdrawal tx", blockExplorerLink(completion.withdrawal.txId, destination.chainId));
  }
  printLine(
    "Withdrawal request amount",
    `${formatAmount(sweepPlan.withdrawalAmount, destination.tokenDecimals)} ${destination.tokenSymbol}`
  );
  printLine(
    "Expected recipient amount",
    `${formatAmount(sweepPlan.expectedRecipientAmount, destination.tokenDecimals)} ${destination.tokenSymbol}`,
    0,
    true
  );
  printLine("Observed completed at", new Date(completion.observedCompletedAtMs).toISOString());
  if (sweepPlan.residualBalance.gt(BigNumber.from(0))) {
    printLine(
      "Residual Binance balance",
      `${formatAmount(sweepPlan.residualBalance, destination.tokenDecimals)} ${destination.tokenSymbol}`
    );
  }
}

export function buildSweepPlan(params: { destination: ResolvedBinanceAsset; freeBalance: BigNumber }): SweepPlan {
  const { destination, freeBalance } = params;
  const withdrawMin = parseCoinBalance(destination.network.withdrawMin, destination.tokenDecimals);
  const withdrawMax = parseCoinBalance(destination.network.withdrawMax, destination.tokenDecimals);
  const withdrawalFee = parseCoinBalance(destination.network.withdrawFee, destination.tokenDecimals);

  if (freeBalance.lte(BigNumber.from(0))) {
    throw new Error(
      `No free ${destination.tokenSymbol} balance is available on Binance for ${getNetworkName(destination.chainId)} (${destination.chainId}).`
    );
  }

  const cappedByWithdrawMax = freeBalance.gt(withdrawMax);
  const withdrawalAmount = cappedByWithdrawMax ? withdrawMax : freeBalance;
  if (withdrawalAmount.lt(withdrawMin)) {
    throw new Error(
      `Free Binance balance ${formatAmount(freeBalance, destination.tokenDecimals)} ${destination.tokenSymbol} is below Binance minimum withdrawal size ${formatAmount(withdrawMin, destination.tokenDecimals)} ${destination.tokenSymbol} for ${getNetworkName(destination.chainId)} (${destination.chainId}).`
    );
  }
  if (withdrawalAmount.lte(withdrawalFee)) {
    throw new Error(
      `Withdrawal fee ${formatAmount(withdrawalFee, destination.tokenDecimals)} ${destination.tokenSymbol} is greater than or equal to the requested sweep amount ${formatAmount(withdrawalAmount, destination.tokenDecimals)} ${destination.tokenSymbol}.`
    );
  }

  return {
    freeBalance,
    withdrawalAmount,
    withdrawalFee,
    expectedRecipientAmount: withdrawalAmount.sub(withdrawalFee),
    residualBalance: freeBalance.sub(withdrawalAmount),
    cappedByWithdrawMax,
  };
}

function printSummary(params: {
  token: string;
  destination: ResolvedBinanceAsset;
  recipient: string;
  sweepPlan: SweepPlan;
  withdrawalQuotaUsed: number;
  withdrawalQuotaTotal: number;
}): void {
  const { destination, recipient, sweepPlan } = params;

  printSection("Quote");
  printLine("Token", `${params.token} on ${getNetworkName(destination.chainId)} (${destination.chainId})`);
  printLine("Recipient", recipient);
  printLine(
    "Expected recipient amount",
    `${formatAmount(sweepPlan.expectedRecipientAmount, destination.tokenDecimals)} ${destination.tokenSymbol}`
  );
  printLine(
    "Binance withdrawal request amount",
    `${formatAmount(sweepPlan.withdrawalAmount, destination.tokenDecimals)} ${destination.tokenSymbol}`,
    1
  );
  printLine(
    "Current free Binance balance",
    `${formatAmount(sweepPlan.freeBalance, destination.tokenDecimals)} ${destination.tokenSymbol}`,
    1
  );
  printLine(
    "Withdrawal fee",
    `${formatAmount(sweepPlan.withdrawalFee, destination.tokenDecimals)} ${destination.tokenSymbol}`,
    1
  );
  if (sweepPlan.cappedByWithdrawMax) {
    printLine(
      "Residual Binance balance after this sweep",
      `${formatAmount(sweepPlan.residualBalance, destination.tokenDecimals)} ${destination.tokenSymbol}`,
      1
    );
    printLine("Binance withdraw max", `${destination.network.withdrawMax} ${destination.tokenSymbol}`, 1);
  }
  printLine(
    "Withdrawal quota used",
    `${params.withdrawalQuotaUsed}/${params.withdrawalQuotaTotal} (${(
      (params.withdrawalQuotaUsed / params.withdrawalQuotaTotal) *
      100
    ).toFixed(2)}%)`
  );

  console.log("");
  console.log("Execution steps:");
  console.log(
    `1. Request a Binance withdrawal for ${destination.tokenSymbol} on ${getNetworkName(destination.chainId)}.`
  );
  console.log("2. Poll Binance until the withdrawal reaches a terminal completed state.");
  console.log("3. Inspect the destination-chain explorer link for the recipient or withdrawal transaction.");
}

function buildDestinationResolutionError(
  tokenSymbol: string,
  chainId: number,
  accountCoins: Coin[],
  reason: string
): string {
  const title = `Destination token ${tokenSymbol} on ${getNetworkName(chainId)} (${chainId}) is not usable for Binance withdrawal.`;
  switch (reason) {
    case "UNKNOWN_TOKEN":
      return `${title}\nEligible known tokens on this chain: ${getEligibleKnownTokensForChain(accountCoins, chainId).join(", ") || "none"}`;
    case "UNSUPPORTED_CHAIN":
      return `${title}\nAvailable chains for ${tokenSymbol}: ${formatChainList(getAvailableChainsForToken(accountCoins, tokenSymbol)) || "none"}`;
    case "CONTRACT_ADDRESS_MISMATCH":
      return `${title}\nBinance exposes a network for ${tokenSymbol}, but its contract address does not match the token address configured in this repo on chain ${chainId}.`;
    case "WITHDRAW_DISABLED":
      return `${title}\nBinance currently reports withdrawals disabled for this network.`;
    case "MEMO_REQUIRED":
      return `${title}\nThis Binance network requires a memo/tag or other extra withdrawal fields. This script only supports plain-address withdrawals.`;
    default:
      return title;
  }
}

function getEligibleKnownTokensForChain(accountCoins: Coin[], chainId: number): string[] {
  return Object.keys(TOKEN_SYMBOLS_MAP)
    .filter(
      (symbol) =>
        resolveBinanceAsset({
          accountCoins,
          tokenSymbol: symbol,
          chainId,
          direction: "withdraw",
        }).ok
    )
    .sort();
}

function getAvailableChainsForToken(accountCoins: Coin[], tokenSymbol: string): number[] {
  return Object.keys(BINANCE_NETWORKS)
    .map(Number)
    .filter(
      (chainId) =>
        resolveBinanceAsset({
          accountCoins,
          tokenSymbol,
          chainId,
          direction: "withdraw",
        }).ok
    )
    .sort((a, b) => a - b);
}

function formatChainList(chainIds: number[]): string {
  return chainIds.map((chainId) => `${getNetworkName(chainId)} (${chainId})`).join(", ");
}

function parseArgs(): ParsedArgs & {
  help?: boolean;
  token?: string;
  dstChain?: string;
  recipient?: string;
} {
  return minimist(process.argv.slice(2), {
    boolean: ["help"],
    string: ["token", "dstChain", "recipient"],
    alias: {
      help: "h",
    },
  });
}

function requiredStringFlag(args: ParsedArgs, flag: string): string {
  const value = args[flag];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required flag --${flag}`);
  }
  return value.trim();
}

function requiredChainFlag(args: ParsedArgs, flag: string): number {
  const value = Number(requiredStringFlag(args, flag));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Flag --${flag} must be a positive integer chain id`);
  }
  return value;
}

function parseCoinBalance(balance: string, decimals: number): BigNumber {
  try {
    return parseUnits(balance, decimals);
  } catch {
    return parseUnits(truncate(Number(balance), decimals).toString(), decimals);
  }
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

function formatAmount(amount: BigNumber, decimals: number): string {
  return createFormatFunction(2, 6, false, decimals)(amount.toString());
}

function printSection(title: string): void {
  console.log(`\n=== ${title} ===\n`);
}

function printLine(label: string, value: string, indentLevel = 0, emphasized = false): void {
  const line = `${"\t".repeat(indentLevel)}${label}: ${value}`;
  console.log(emphasized ? `\u001b[1m${line}\u001b[0m` : line);
}

function describeWithdrawalStatus(withdrawal: BinanceWithdrawal): string {
  const txSuffix = withdrawal.txId ? ` txId=${withdrawal.txId}` : "";
  return `status=${readableBinanceWithdrawalStatus(withdrawal.status)} amount=${withdrawal.amount} ${resolveBinanceCoinSymbol(withdrawal.coin)}${txSuffix}`;
}

function printHelp(): void {
  console.log(`Usage:
  yarn ts-node ./scripts/sweepBinanceBalance.ts --token <symbol> --dstChain <chainId> --recipient <address> [--binanceSecretKey <gckms-key>]

Required flags:
  --token         Binance / repo token symbol to sweep, for example TRX, USDC, ETH.
  --dstChain      Destination chain id, for example 728126428 for Tron.
  --recipient     Destination-chain-native recipient address.

Notes:
  - This script sweeps the current free Binance balance for the chosen token on the selected withdrawal network.
  - If the Binance free balance exceeds the network withdraw max, the script withdraws the maximum allowed amount and leaves the residual balance on Binance.
  - Withdrawal fees are deducted from the requested amount because the script uses transactionFeeFlag=false.
  - This script is Binance-only and does not require --wallet.

Example:
  yarn ts-node ./scripts/sweepBinanceBalance.ts --token TRX --dstChain 728126428 --recipient TRX_ACCOUNT --binanceSecretKey binance-secret`);
}

if (require.main === module) {
  run()
    .then(async () => {
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("Sweep failed:");
      console.error(error instanceof Error ? error.message : String(error));
      if (error instanceof Error && error.stack) {
        console.error(error.stack);
      }
      process.exit(1);
    });
}

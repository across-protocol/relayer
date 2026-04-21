import {
  winston,
  processEndPollingLoop,
  config,
  startupLogLevel,
  Signer,
  disconnectRedisClients,
  formatUnits,
  BigNumber,
  bnZero,
} from "../utils";
import { TOKEN_EQUIVALENCE_REMAPPING } from "@across-protocol/constants";
import { Monitor } from "../monitor/Monitor";
import { constructMonitorClients } from "../monitor/MonitorClientHelper";
import { BalanceTrackerConfig } from "./BalanceTrackerConfig";
import { SheetsWriter } from "./SheetsWriter";
config();

let logger: winston.Logger;

// Preserve these symbols as distinct columns even though the SDK remaps them to an L1 equivalent.
// USDC.e, USDH, WGHO represent distinct assets we want to track separately.
const PRESERVED_DISTINCT_SYMBOLS = new Set(["USDC.e", "USDH", "WGHO"]);

function normalizeSymbol(symbol: string): string {
  if (PRESERVED_DISTINCT_SYMBOLS.has(symbol)) {
    return symbol;
  }
  return TOKEN_EQUIVALENCE_REMAPPING[symbol] ?? symbol;
}

// Aggregate a relayer's balances by display symbol, applying TOKEN_EQUIVALENCE_REMAPPING
// (so ETH rolls into WETH, USDB into DAI, USDC-BNB/USDbC/USDzC into USDC, etc.) except for
// a short list of distinct variants we want as their own columns.
export async function runBalanceTracker(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  logger = _logger;
  const btConfig = new BalanceTrackerConfig(process.env);
  const clients = await constructMonitorClients(btConfig, logger, baseSigner);
  const monitor = new Monitor(logger, btConfig, clients);

  const sheetsWriter = btConfig.sheetsWriteEnabled
    ? new SheetsWriter(logger, btConfig.spreadsheetId, btConfig.sheetsCredentials)
    : undefined;

  try {
    logger[startupLogLevel(btConfig)]({
      at: "BalanceTracker#index",
      message: "Balance tracker started",
      sheetsWriteEnabled: btConfig.sheetsWriteEnabled,
      spreadsheetId: btConfig.spreadsheetId,
    });

    for (;;) {
      const loopStart = Date.now();

      await monitor.update();
      const report = await monitor.computeRelayerBalances();

      const now = new Date().toISOString();

      for (const [relayer, perToken] of Object.entries(report)) {
        // Aggregate by display symbol. For balance rows, display symbol = L2 token symbol
        // (so USDC.e, USDH, WGHO are separate). For refunds, display symbol = L1 token symbol.
        const buckets = new Map<
          string,
          { current: BigNumber; pending: BigNumber; upcomingRefunds: BigNumber; decimals: number }
        >();

        const ensureBucket = (symbol: string, decimals: number) => {
          let b = buckets.get(symbol);
          if (!b) {
            b = { current: bnZero, pending: bnZero, upcomingRefunds: bnZero, decimals };
            buckets.set(symbol, b);
          }
          return b;
        };

        for (const tokenReport of Object.values(perToken)) {
          const l1Decimals = tokenReport.l1Token.decimals;

          for (const row of tokenReport.rows) {
            const b = ensureBucket(normalizeSymbol(row.tokenSymbol), l1Decimals);
            b.current = b.current.add(row.current);
            b.pending = b.pending.add(row.pending);
          }

          if (!tokenReport.upcomingRefundsTotal.isZero()) {
            const b = ensureBucket(normalizeSymbol(tokenReport.l1Token.symbol), l1Decimals);
            b.upcomingRefunds = b.upcomingRefunds.add(tokenReport.upcomingRefundsTotal);
          }
        }

        const tokenTotals = new Map<string, number>();
        const tokenBreakdown: Record<string, Record<string, number>> = {};

        for (const [symbol, { current, pending, upcomingRefunds, decimals }] of buckets) {
          const total = current.add(pending).add(upcomingRefunds);
          if (total.isZero()) {
            continue;
          }
          tokenTotals.set(symbol, Number(formatUnits(total, decimals)));
          tokenBreakdown[symbol] = {
            current: Number(formatUnits(current, decimals)),
            pending: Number(formatUnits(pending, decimals)),
            upcomingRefunds: Number(formatUnits(upcomingRefunds, decimals)),
            total: Number(formatUnits(total, decimals)),
          };
        }

        const symbols = [...tokenTotals.keys()].sort();
        const row = [now, ...symbols.map((s) => String(tokenTotals.get(s)!))];

        logger.debug({
          at: "BalanceTracker#index",
          message: `Computed balances for ${symbols.length} tokens for ${relayer}`,
          breakdown: tokenBreakdown,
        });

        if (sheetsWriter) {
          try {
            await sheetsWriter.appendRow(relayer, symbols, row);
          } catch (err) {
            logger.warn({
              at: "BalanceTracker#index",
              message: `Failed to write to Google Sheets for ${relayer}`,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      logger.debug({
        at: "BalanceTracker#index",
        message: `Time to loop: ${(Date.now() - loopStart) / 1000}s`,
      });

      if (await processEndPollingLoop(logger, "BalanceTracker#index", btConfig.pollingDelay)) {
        break;
      }
    }
  } finally {
    await disconnectRedisClients(logger);
  }
}

import {
  winston,
  processEndPollingLoop,
  config,
  startupLogLevel,
  Signer,
  disconnectRedisClients,
  formatUnits,
} from "../utils";
import { Monitor, ALL_CHAINS_NAME } from "../monitor/Monitor";
import { constructMonitorClients } from "../monitor/MonitorClientHelper";
import { BalanceTrackerConfig } from "./BalanceTrackerConfig";
import { SheetsWriter } from "./SheetsWriter";
config();

let logger: winston.Logger;

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
      const { reports, allL1Tokens, l2OnlyTokens } = await monitor.computeRelayerBalances();

      // Build a decimal lookup from all tracked tokens.
      const tokenDecimals = new Map<string, number>();
      for (const t of allL1Tokens) {
        tokenDecimals.set(t.symbol, t.decimals);
      }
      for (const t of l2OnlyTokens) {
        tokenDecimals.set(t.symbol, t.decimals);
      }

      const now = new Date().toISOString();

      for (const [relayer, balanceTable] of Object.entries(reports)) {
        // Build a single row: time, then total balance per token (summed across all chains).
        const tokenTotals = new Map<string, number>();
        for (const [tokenSymbol, columns] of Object.entries(balanceTable)) {
          const decimals = tokenDecimals.get(tokenSymbol);
          if (decimals === undefined) {
            continue;
          }
          const allChainsCell = columns[ALL_CHAINS_NAME];
          const total = allChainsCell?.["total"];
          if (total && !total.isZero()) {
            tokenTotals.set(tokenSymbol, Number(formatUnits(total, decimals)));
          }
        }

        const symbols = [...tokenTotals.keys()].sort();
        const row = [now, ...symbols.map((s) => String(tokenTotals.get(s)!))];

        logger.debug({
          at: "BalanceTracker#index",
          message: `Computed balances for ${symbols.length} tokens for ${relayer}`,
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

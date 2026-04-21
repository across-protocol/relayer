import {
  winston,
  processEndPollingLoop,
  config,
  startupLogLevel,
  Signer,
  disconnectRedisClients,
  formatUnits,
} from "../utils";
import { Monitor } from "../monitor/Monitor";
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
      const report = await monitor.computeRelayerBalances();

      const now = new Date().toISOString();

      for (const [relayer, perToken] of Object.entries(report)) {
        const tokenTotals = new Map<string, number>();
        const tokenBreakdown: Record<string, Record<string, number>> = {};

        for (const [tokenSymbol, tokenReport] of Object.entries(perToken)) {
          const decimals = tokenReport.l1Token.decimals;
          if (tokenReport.tokenTotal.isZero()) {
            continue;
          }
          tokenTotals.set(tokenSymbol, Number(formatUnits(tokenReport.tokenTotal, decimals)));
          tokenBreakdown[tokenSymbol] = {
            current: Number(formatUnits(tokenReport.currentTotal, decimals)),
            pending: Number(formatUnits(tokenReport.pendingTotal, decimals)),
            upcomingRefunds: Number(formatUnits(tokenReport.upcomingRefundsTotal, decimals)),
            total: Number(formatUnits(tokenReport.tokenTotal, decimals)),
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

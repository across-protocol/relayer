import { InventoryClient } from "../clients";
import { updateSpokePoolClients } from "../common";
import { constructRelayerClients } from "../relayer/RelayerClientHelper";
import { RelayerConfig } from "../relayer/RelayerConfig";
import {
  assert,
  BigNumber,
  bnZero,
  config,
  ConvertDecimals,
  disconnectRedisClients,
  getTokenInfoFromSymbol,
  isDefined,
  Signer,
  toBNWei,
  winston,
} from "../utils";
import { CumulativeBalanceRebalancerClient } from "./clients/CumulativeBalanceRebalancerClient";

import { constructCumulativeBalanceRebalancerClient } from "./RebalancerClientHelper";
import { RebalancerConfig } from "./RebalancerConfig";
import { RebalancerAdapter, RebalancerClient } from "./utils/interfaces";
config();
let logger: winston.Logger;

type RebalancerRunContext = {
  rebalancerConfig: RebalancerConfig;
  adaptersToUpdate: Set<RebalancerAdapter>;
  inventoryClient: InventoryClient;
  rebalancerClient: RebalancerClient;
};

const sweepableAdapters: string[] = ["hyperliquid"];

async function initializeRebalancerRun(_logger: winston.Logger, baseSigner: Signer): Promise<RebalancerRunContext> {
  const logLabel = "runCumulativeBalanceRebalancer";
  logger = _logger;
  const rebalancerConfig = new RebalancerConfig(process.env);
  logger.debug({ at: `index.ts:${logLabel}`, message: "Rebalancer Config loaded", rebalancerConfig });
  const relayerConfig = new RelayerConfig(process.env);
  const { addressFilter: _addressFilter, ...loggedConfig } = relayerConfig;
  logger.debug({ at: `index.ts:${logLabel}`, message: "Relayer Config loaded", loggedConfig });
  const relayerClients = await constructRelayerClients(logger, relayerConfig, baseSigner);
  const { spokePoolClients, inventoryClient, tokenClient } = relayerClients;

  await Promise.all([
    updateSpokePoolClients(spokePoolClients, [
      "FundsDeposited",
      "FilledRelay",
      "RelayedRootBundle",
      "ExecutedRelayerRefundRoot",
    ]),
    tokenClient.update(),
  ]);

  const inventoryManagement = inventoryClient.isInventoryManagementEnabled();
  // One time initialization of functions that handle lots of events only after all spokePoolClients are updated.
  if (inventoryManagement) {
    inventoryClient.setBundleData();
    await inventoryClient.update(rebalancerConfig.chainIds);
  }
  const rebalancerClient = await constructCumulativeBalanceRebalancerClient(logger, baseSigner);

  let timerStart = performance.now();

  // Make sure we update the upstream adapters first, so there is a small chance of progressing an intermediate
  // CCTP/OFT bridge before progressing the order in Binance/HL.
  const allAdapters = Object.keys(rebalancerClient.adapters);
  const upstreamAdapterNames: string[] = allAdapters.filter((adapter) => adapter === "cctp" || adapter === "oft");
  const downstreamAdapterNames = allAdapters.filter((adapter) => !upstreamAdapterNames.includes(adapter));
  const adapterNamesToUpdate = [...upstreamAdapterNames, ...downstreamAdapterNames];
  const adaptersToUpdate = new Set(adapterNamesToUpdate.map((adapterName) => rebalancerClient.adapters[adapterName]));
  for (const adapterName of adapterNamesToUpdate) {
    const adapter = rebalancerClient.adapters[adapterName];
    timerStart = performance.now();
    // @todo Decide when to sweep, for now do it before updating rebalance statuses. In theory, it shouldn't really
    // matter when we sweep.
    if (sweepableAdapters.includes(adapterName)) {
      await adapter.sweepIntermediateBalances();
      logger.debug({
        at: `index.ts:${logLabel}`,
        message: `Completed sweeping intermediate balances for adapter ${adapter.constructor.name}`,
        duration: performance.now() - timerStart,
      });
      timerStart = performance.now();
    }
    await adapter.updateRebalanceStatuses();
    logger.debug({
      at: `index.ts:${logLabel}`,
      message: `Completed updating rebalance statuses for adapter ${adapter.constructor.name}`,
      duration: performance.now() - timerStart,
    });
  }

  return {
    rebalancerConfig,
    adaptersToUpdate,
    inventoryClient,
    rebalancerClient,
  };
}

function loadCumulativeModeBalances(
  rebalancerConfig: RebalancerConfig,
  inventoryClient: InventoryClient
): {
  currentBalances: { [chainId: number]: { [token: string]: BigNumber } };
  cumulativeBalances: { [token: string]: BigNumber };
} {
  // Note: Current balances should be fetched from TokenClient, because we can only rebalance using amounts
  // that we have on-chain. However, cumulative balances, which are compared against targets/thresholds
  // should contain virtual balance modifications, because these comparisons are used to trigger actual rebalances.
  const currentBalances: { [chainId: number]: { [token: string]: BigNumber } } = {};
  const cumulativeBalances: { [token: string]: BigNumber } = {};
  for (const [token, chainConfig] of Object.entries(rebalancerConfig.cumulativeTargetBalances)) {
    const l1TokenInfo = getTokenInfoFromSymbol(token, rebalancerConfig.hubPoolChainId);
    assert(l1TokenInfo.address.isEVM());
    Object.keys(chainConfig.chains)
      .map(Number)
      .forEach((chainId) => {
        const l2TokenInfo = getTokenInfoFromSymbol(token, chainId);
        assert(l2TokenInfo.address.isEVM());
        const currentBalance = inventoryClient.tokenClient.getBalance(chainId, l2TokenInfo.address);
        currentBalances[chainId] ??= {};
        currentBalances[chainId][token] = currentBalance;
      });

    cumulativeBalances[token] = inventoryClient.getCumulativeBalanceWithApproximateUpcomingRefunds(l1TokenInfo.address);
  }
  return { currentBalances, cumulativeBalances };
}

async function applyPendingCumulativeRebalanceAdjustments(
  rebalancerConfig: RebalancerConfig,
  adaptersToUpdate: Set<RebalancerAdapter>,
  logLabel: string,
  cumulativeBalances?: { [token: string]: BigNumber }
): Promise<void> {
  let timerStart = performance.now();
  for (const adapter of adaptersToUpdate) {
    timerStart = performance.now();
    const pendingRebalances = await adapter.getPendingRebalances();
    logger.debug({
      at: `index.ts:${logLabel}`,
      message: `Completed getting pending rebalances for adapter ${adapter.constructor.name}`,
      duration: performance.now() - timerStart,
    });
    if (Object.keys(pendingRebalances).length > 0) {
      logger.debug({
        at: `index.ts:${logLabel}`,
        message: `Pending rebalances for adapter ${adapter.constructor.name}`,
        pendingRebalances: Object.entries(pendingRebalances).map(([chainId, tokens]) => ({
          [chainId]: Object.fromEntries(Object.entries(tokens).map(([token, amount]) => [token, amount.toString()])),
        })),
      });
    }

    for (const [chainId, tokens] of Object.entries(pendingRebalances)) {
      for (const [token, amount] of Object.entries(tokens)) {
        const pendingRebalanceAmount = amount ?? bnZero;
        if (cumulativeBalances && isDefined(cumulativeBalances[token])) {
          // Convert pending rebalance amount to L1 token decimals
          const l1TokenInfo = getTokenInfoFromSymbol(token, rebalancerConfig.hubPoolChainId);
          const chainDecimals = getTokenInfoFromSymbol(token, Number(chainId)).decimals;
          const chainToL1Converter = ConvertDecimals(chainDecimals, l1TokenInfo.decimals);
          const pendingRebalanceAmountConverted = chainToL1Converter(pendingRebalanceAmount);
          cumulativeBalances[token] = cumulativeBalances[token].add(pendingRebalanceAmountConverted);
        }

        if (!pendingRebalanceAmount.eq(bnZero)) {
          logger.debug({
            at: `index.ts:${logLabel}`,
            message: `${pendingRebalanceAmount.gt(bnZero) ? "Added" : "Subtracted"} pending rebalance amount from ${
              adapter.constructor.name
            } of ${pendingRebalanceAmount.toString()} to cumulative (virtual) balance for ${token} on ${chainId}`,
            pendingRebalanceAmount: pendingRebalanceAmount.toString(),
            newCumulativeBalance: cumulativeBalances?.[token]?.toString(),
          });
        }
      }
    }
  }
}

export async function runCumulativeBalanceRebalancer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  const logLabel = "runCumulativeBalanceRebalancer";
  const { rebalancerConfig, adaptersToUpdate, inventoryClient, rebalancerClient } = await initializeRebalancerRun(
    _logger,
    baseSigner
  );
  const { currentBalances, cumulativeBalances } = loadCumulativeModeBalances(rebalancerConfig, inventoryClient);
  await applyPendingCumulativeRebalanceAdjustments(rebalancerConfig, adaptersToUpdate, logLabel, cumulativeBalances);

  let timerStart = performance.now();
  // Finally, send out new rebalances:
  try {
    if (process.env.SEND_REBALANCES === "true") {
      timerStart = performance.now();
      const maxFeePct = toBNWei(process.env.MAX_FEE_PCT ?? "2.5", 18);
      await (rebalancerClient as CumulativeBalanceRebalancerClient).rebalanceInventory(
        cumulativeBalances,
        currentBalances,
        maxFeePct
      );
      logger.debug({
        at: `index.ts:${logLabel}`,
        message: "Completed rebalancing inventory",
        duration: performance.now() - timerStart,
      });
      timerStart = performance.now();
    }
    // Maybe now enter a loop where we update rebalances continuously every X seconds until the next run where
    // we call rebalance inventory? The thinking is we should rebalance inventory once per "run" and then continually
    // update rebalance statuses/finalize pending rebalances.
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Error running rebalancer", error);
    throw error;
  } finally {
    await disconnectRedisClients(logger);
  }
}

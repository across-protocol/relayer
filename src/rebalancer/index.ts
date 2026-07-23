import { InventoryClient, TokenClient } from "../clients";
import { updateSpokePoolClients } from "../common";
import { constructRelayerClients, RelayerClients } from "../relayer/RelayerClientHelper";
import { RelayerConfig } from "../relayer/RelayerConfig";
import {
  assert,
  BigNumber,
  config,
  disconnectRedisClients,
  getTokenInfoFromSymbol,
  Signer,
  toBNWei,
  winston,
} from "../utils";
import { CumulativeBalanceRebalancerClient } from "./clients/CumulativeBalanceRebalancerClient";
import { SameAssetRebalancerClient } from "./clients/SameAssetRebalancerClient";

import {
  constructCumulativeBalanceRebalancerClient,
  constructSameAssetRebalancerClient,
} from "./RebalancerClientHelper";
import { RebalancerConfig } from "./RebalancerConfig";
import { RebalancerClient } from "./utils/interfaces";
config();
let logger: winston.Logger;

type RebalancerRunContext = {
  rebalancerConfig: RebalancerConfig;
  inventoryClient: InventoryClient;
  rebalancerClient: RebalancerClient;
};
type RebalancerClientConstructor = (_logger: winston.Logger, baseSigner: Signer) => Promise<RebalancerClient>;

const sweepableAdapters: string[] = ["hyperliquid"];

async function setupClients(
  _logger: winston.Logger,
  baseSigner: Signer,
  logLabel: string
): Promise<{
  relayerClients: RelayerClients;
  rebalancerConfig: RebalancerConfig;
}> {
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
  return {
    relayerClients,
    rebalancerConfig,
  };
}

async function updateAdapters(
  rebalancerClient: RebalancerClient,
  rebalancerConfig: RebalancerConfig,
  tokenClient: TokenClient,
  inventoryClient: InventoryClient,
  logLabel: string
): Promise<void> {
  let timerStart = performance.now();

  // Make sure we update the upstream adapters first, so there is a small chance of progressing an intermediate
  // CCTP/OFT bridge before progressing the order in Binance/HL.
  const allAdapters = Object.keys(rebalancerClient.adapters);
  const upstreamAdapterNames: string[] = allAdapters.filter((adapter) => adapter === "cctp" || adapter === "oft");
  const downstreamAdapterNames = allAdapters.filter((adapter) => !upstreamAdapterNames.includes(adapter));
  const adapterNamesToUpdate = [...upstreamAdapterNames, ...downstreamAdapterNames];
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

  // Refresh on-chain balances before `loadCumulativeModeBalances` reads them. The initial
  // `tokenClient.update()` above ran before adapter sweeps and `updateRebalanceStatuses`, both
  // of which submit OFT/CCTP/Hypercore transactions that move funds across chains, so the
  // cached balances are stale by this point. Without this refresh, `rebalanceInventory` can
  // size a new bridge against a pre-burn balance and crash on the OFT/CCTP simulation revert
  // (`ERC20: burn amount exceeds balance`).
  timerStart = performance.now();
  await tokenClient.update();
  logger.debug({
    at: `index.ts:${logLabel}`,
    message: "Refreshed TokenClient balances post-status-update",
    duration: performance.now() - timerStart,
  });
  const inventoryManagement = inventoryClient.isInventoryManagementEnabled();
  if (inventoryManagement) {
    await inventoryClient.update(rebalancerConfig.chainIds);
  }
}

async function initializeRebalancerRun(
  _logger: winston.Logger,
  baseSigner: Signer,
  logLabel: string,
  constructRebalancerClient: RebalancerClientConstructor
): Promise<RebalancerRunContext> {
  logger = _logger;
  const { relayerClients, rebalancerConfig } = await setupClients(logger, baseSigner, logLabel);
  const { inventoryClient, tokenClient } = relayerClients;
  const rebalancerClient = await constructRebalancerClient(logger, baseSigner);
  await updateAdapters(rebalancerClient, rebalancerConfig, tokenClient, inventoryClient, logLabel);

  return {
    rebalancerConfig,
    inventoryClient,
    rebalancerClient,
  };
}

export function loadCumulativeModeBalances(
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
        const currentBalance = inventoryClient.tokenClient.getBalance(chainId, l2TokenInfo.address);
        currentBalances[chainId] ??= {};
        currentBalances[chainId][token] = currentBalance;
      });

    cumulativeBalances[token] = inventoryClient.getCumulativeBalanceWithApproximateUpcomingRefunds(l1TokenInfo.address);
  }
  return { currentBalances, cumulativeBalances };
}

// Fail closed when pending-rebalance accounting is degraded: the deficit/excess math that sizes new rebalances is
// derived from the InventoryClient's virtual balances, and if any adapter's pending read failed then those balances
// are missing every in-flight rebalance credit (the aggregate degrades to net debits only), so sending now could
// duplicate rebalances that are already pending — including through adapters whose reads succeeded.
function canSendRebalances(inventoryClient: InventoryClient, logLabel: string): boolean {
  const failedPendingReads = inventoryClient.rebalancerClient.getPendingReadFailures();
  if (failedPendingReads.length === 0) {
    return true;
  }
  logger.warn({
    at: `index.ts:${logLabel}`,
    message: "Skipping new rebalances this run because pending-rebalance reads failed for some adapters",
    failedPendingReads,
  });
  return false;
}

export async function runCumulativeBalanceRebalancer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  const logLabel = "runCumulativeBalanceRebalancer";
  const { rebalancerConfig, inventoryClient, rebalancerClient } = await initializeRebalancerRun(
    _logger,
    baseSigner,
    logLabel,
    constructCumulativeBalanceRebalancerClient
  );
  const { currentBalances, cumulativeBalances } = loadCumulativeModeBalances(rebalancerConfig, inventoryClient);

  let timerStart = performance.now();
  // Finally, send out new rebalances:
  try {
    if (process.env.SEND_REBALANCES === "true" && canSendRebalances(inventoryClient, logLabel)) {
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

export async function runSameAssetRebalancer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  const logLabel = "runSameAssetRebalancer";
  const { rebalancerClient, inventoryClient } = await initializeRebalancerRun(
    _logger,
    baseSigner,
    logLabel,
    constructSameAssetRebalancerClient
  );

  let timerStart = performance.now();
  try {
    if (process.env.SEND_REBALANCES === "true" && canSendRebalances(inventoryClient, logLabel)) {
      timerStart = performance.now();
      const maxFeePct = toBNWei(process.env.MAX_FEE_PCT ?? "2.5", 18);
      await (rebalancerClient as SameAssetRebalancerClient).rebalanceInventory(inventoryClient, maxFeePct);
      logger.debug({
        at: `index.ts:${logLabel}`,
        message: "Completed rebalancing inventory",
        duration: performance.now() - timerStart,
      });
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Error running rebalancer", error);
    throw error;
  } finally {
    await disconnectRedisClients(logger);
  }
}

import { updateSpokePoolClients } from "../common";
import { constructRelayerClients } from "../relayer/RelayerClientHelper";
import { RelayerConfig } from "../relayer/RelayerConfig";
import {
  BigNumber,
  bnZero,
  CHAIN_IDs,
  config,
  ConvertDecimals,
  disconnectRedisClients,
  EvmAddress,
  getTokenInfoFromSymbol,
  Signer,
  toBNWei,
  winston,
} from "../utils";
import { RebalancerAdapter } from "./rebalancer";
import { constructRebalancerClient } from "./RebalancerClientHelper";
import { RebalancerConfig } from "./RebalancerConfig";
config();
let logger: winston.Logger;

export async function runRebalancer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  logger = _logger;
  const rebalancerConfig = new RebalancerConfig(process.env);
  logger.debug({ at: "index.ts:runRebalancer", message: "Rebalancer Config loaded", rebalancerConfig });
  const relayerConfig = new RelayerConfig(process.env);
  const { addressFilter: _addressFilter, ...loggedConfig } = relayerConfig;
  logger.debug({ at: "index.ts:runRebalancer", message: "Relayer Config loaded", loggedConfig });
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
  const rebalancerClient = await constructRebalancerClient(logger, baseSigner);

  let timerStart = performance.now();

  // Update all adapter order statuses so we can get the most accurate latest balances, and then query their balances.
  const adaptersToUpdate: Set<RebalancerAdapter> = new Set(Object.values(rebalancerClient.adapters));
  for (const adapter of adaptersToUpdate) {
    timerStart = performance.now();
    // @todo Decide when to sweep, for now do it before updating rebalance statuses. In theory, it shouldn't really
    // matter when we sweep.
    await adapter.sweepIntermediateBalances();
    logger.debug({
      at: "index.ts:runRebalancer",
      message: `Completed sweeping intermediate balances for adapter ${adapter.constructor.name}`,
      duration: performance.now() - timerStart,
    });
    timerStart = performance.now();
    await adapter.updateRebalanceStatuses();
    logger.debug({
      at: "index.ts:runRebalancer",
      message: `Completed updating rebalance statuses for adapter ${adapter.constructor.name}`,
      duration: performance.now() - timerStart,
    });
  }

  // Set current balances for all tokens and chains:
  const currentBalances: { [chainId: number]: { [token: string]: BigNumber } } = {};
  const allTokens = new Set(
    Object.keys(rebalancerConfig.targetBalances).concat(Object.keys(rebalancerConfig.cumulativeTargetBalances))
  );
  for (const token of allTokens) {
    const l1TokenInfo = getTokenInfoFromSymbol(token, CHAIN_IDs.MAINNET);
    const allChains = new Set(
      Object.keys(rebalancerConfig.targetBalances?.[token] ?? {}).concat(
        Object.keys(rebalancerConfig.cumulativeTargetBalances?.[token]?.chains ?? {})
      )
    );
    for (const chainId of allChains) {
      const l2TokenInfo = getTokenInfoFromSymbol(token, Number(chainId));
      const currentBalance = inventoryClient.getChainBalance(
        Number(chainId),
        EvmAddress.from(l1TokenInfo.address.toNative()),
        EvmAddress.from(l2TokenInfo.address.toNative())
      );
      const convertDecimalsToSourceChain = ConvertDecimals(l1TokenInfo.decimals, l2TokenInfo.decimals);
      currentBalances[chainId] ??= {};
      currentBalances[chainId][token] = convertDecimalsToSourceChain(currentBalance);
    }
  }

  // Set cumulative balances for all tokens:
  const cumulativeBalances: { [token: string]: BigNumber } = {};
  for (const token of Object.keys(rebalancerConfig.cumulativeTargetBalances)) {
    const l1TokenInfo = getTokenInfoFromSymbol(token, CHAIN_IDs.MAINNET);
    const cumulativeBalance = inventoryClient.getCumulativeBalanceWithApproximateUpcomingRefunds(
      EvmAddress.from(l1TokenInfo.address.toNative())
    );
    cumulativeBalances[token] = cumulativeBalance;
  }

  // Modify all current and cumulative balances with the pending rebalances:
  for (const adapter of adaptersToUpdate) {
    timerStart = performance.now();
    const pendingRebalances = await adapter.getPendingRebalances();
    logger.debug({
      at: "index.ts:runRebalancer",
      message: `Completed getting pending rebalances for adapter ${adapter.constructor.name}`,
      duration: performance.now() - timerStart,
    });
    if (Object.keys(pendingRebalances).length > 0) {
      logger.debug({
        at: "index.ts:runRebalancer",
        message: `Pending rebalances for adapter ${adapter.constructor.name}`,
        pendingRebalances: Object.entries(pendingRebalances).map(([chainId, tokens]) => ({
          [chainId]: Object.fromEntries(Object.entries(tokens).map(([token, amount]) => [token, amount.toString()])),
        })),
      });
    }
    for (const [token, chainConfig] of Object.entries(rebalancerConfig.targetBalances)) {
      for (const chainId of Object.keys(chainConfig)) {
        const pendingRebalanceAmount = pendingRebalances[chainId]?.[token] ?? bnZero;
        currentBalances[chainId] ??= {};
        currentBalances[chainId][token] = (currentBalances[chainId][token] ?? bnZero).add(pendingRebalanceAmount);
        cumulativeBalances[token] = (cumulativeBalances[token] ?? bnZero).add(pendingRebalanceAmount);
        if (!pendingRebalanceAmount.eq(bnZero)) {
          logger.debug({
            at: "index.ts:runRebalancer",
            message: `${pendingRebalanceAmount.gt(bnZero) ? "Added" : "Subtracted"} pending rebalance amount from ${
              adapter.constructor.name
            } of ${pendingRebalanceAmount.toString()} to current balance for ${token} on ${chainId}`,
            pendingRebalanceAmount: pendingRebalanceAmount.toString(),
            newCurrentBalance: currentBalances[chainId][token].toString(),
            newCumulativeBalance: cumulativeBalances[token].toString(),
          });
        }
      }
    }
  }

  // Finally, send out new rebalances:
  try {
    // Resync balances
    // Execute rebalances
    if (process.env.SEND_REBALANCES === "true") {
      timerStart = performance.now();
      const maxFeePct = toBNWei(process.env.MAX_FEE_PCT ?? "2.5", 18);
      // await rebalancerClient.rebalanceInventory(currentBalances, maxFeePct); // Use this mostly for testing.
      await rebalancerClient.rebalanceCumulativeInventory(cumulativeBalances, currentBalances, maxFeePct);
      logger.debug({
        at: "index.ts:runRebalancer",
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

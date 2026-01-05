import { BigNumber, bnUint256Max, bnZero, config, disconnectRedisClients, Signer, toBNWei, winston } from "../utils";
import { BinanceStablecoinSwapAdapter } from "./adapters/binance";
import { HyperliquidStablecoinSwapAdapter } from "./adapters/hyperliquid";
import { RebalancerAdapter, RebalancerClient, RebalanceRoute, TargetBalanceConfig } from "./rebalancer";
import { RebalancerConfig } from "./RebalancerConfig";
config();
let logger: winston.Logger;

export async function runRebalancer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  logger = _logger;
  const currentBalances: { [chainId: number]: { [token: string]: BigNumber } } = {
    1: {
      USDT: toBNWei("0", 6),
      USDC: toBNWei("0", 6),
    },
    10: {
      USDC: toBNWei("10", 6),
      USDT: toBNWei("0", 6),
    },
    42161: {
      USDT: toBNWei("0", 6),
      USDC: toBNWei("0", 6),
    },
    999: {
      USDT: toBNWei("0", 6),
    },
  };

  const targetBalances: TargetBalanceConfig = {
    USDT: {
      "1": { targetBalance: bnUint256Max, priorityTier: 0 },
      "10": { targetBalance: toBNWei("0", 6), priorityTier: 1 },
      "42161": { targetBalance: toBNWei("0", 6), priorityTier: 1 },
      "999": { targetBalance: toBNWei("0", 6), priorityTier: 1 },
    },
    USDC: {
      "1": { targetBalance: bnUint256Max, priorityTier: 0 },
      "10": { targetBalance: toBNWei("0", 6), priorityTier: 1 },
      "42161": { targetBalance: toBNWei("0", 6), priorityTier: 1 },
    },
  };
  const rebalancerConfig = new RebalancerConfig(process.env, targetBalances);

  // Construct adapters:
  const hyperliquidAdapter = new HyperliquidStablecoinSwapAdapter(logger, rebalancerConfig, baseSigner);
  const binanceAdapter = new BinanceStablecoinSwapAdapter(logger, rebalancerConfig, baseSigner);

  const adapters = { hyperliquid: hyperliquidAdapter, binance: binanceAdapter };

  // Initialize list of rebalance routes:
  const rebalanceRoutes: RebalanceRoute[] = [
    {
      sourceChain: 42161,
      destinationChain: 1,
      sourceToken: "USDT",
      destinationToken: "USDC",
      maxAmountToTransfer: toBNWei("10", 6),
      adapter: "binance",
    },
    {
      sourceChain: 10,
      destinationChain: 1,
      sourceToken: "USDC",
      destinationToken: "USDT",
      maxAmountToTransfer: toBNWei("10", 6),
      adapter: "binance",
    },
    // {
    //   sourceChain: 10,
    //   destinationChain: 42161,
    //   sourceToken: "USDT",
    //   destinationToken: "USDC",
    //   maxAmountToTransfer: toBNWei("10.3", 6),
    //   adapter: "hyperliquid",
    // },
    // {
    //   sourceChain: 10,
    //   destinationChain: 42161,
    //   sourceToken: "USDT",
    //   destinationToken: "USDC",
    //   maxAmountToTransfer: toBNWei("10.3", 6),
    //   adapter: "binance",
    // },
    // {
    //   sourceChain: 42161,
    //   destinationChain: 10,
    //   sourceToken: "USDC",
    //   destinationToken: "USDT",
    //   maxAmountToTransfer: toBNWei("10.3", 6),
    //   adapter: "binance",
    // },
    {
      sourceChain: 42161,
      sourceToken: "USDC",
      destinationChain: 999,
      destinationToken: "USDT",
      maxAmountToTransfer: toBNWei("10.3", 6),
      adapter: "hyperliquid",
    },
    {
      sourceChain: 42161,
      sourceToken: "USDT",
      destinationChain: 10,
      destinationToken: "USDC",
      maxAmountToTransfer: toBNWei("10.3", 6),
      adapter: "hyperliquid",
    },
    {
      sourceChain: 10,
      sourceToken: "USDC",
      destinationChain: 42161,
      destinationToken: "USDT",
      maxAmountToTransfer: toBNWei("10.3", 6),
      adapter: "hyperliquid",
    },
  ];
  const rebalancerClient = new RebalancerClient(logger, rebalancerConfig, adapters, rebalanceRoutes, baseSigner);
  let timerStart = performance.now();
  await rebalancerClient.initialize();
  logger.debug({
    at: "index.ts:runRebalancer",
    message: "Completed RebalancerClient initialization",
    duration: performance.now() - timerStart,
  });
  timerStart = performance.now();

  // Update all adapter order statuses so we can get the most accurate latest balances:
  const adaptersToUpdate: Set<RebalancerAdapter> = new Set(rebalanceRoutes.map((x) => adapters[x.adapter]));
  for (const adapter of adaptersToUpdate) {
    await adapter.updateRebalanceStatuses();

    // // There should probably be a delay between the above and `getPendingRebalances` to allow for any newly transmitted
    // // transactions to get mined.
    // await delay(5);

    // Modify all current balances with the pending rebalances:
    const pendingRebalances = await adapter.getPendingRebalances();
    if (Object.keys(pendingRebalances).length > 0) {
      logger.debug({
        at: "index.ts:runRebalancer",
        message: "Pending rebalances",
        pendingRebalances: Object.entries(pendingRebalances).map(([chainId, tokens]) => ({
          [chainId]: Object.fromEntries(Object.entries(tokens).map(([token, amount]) => [token, amount.toString()])),
        })),
      });
    }
    for (const [chainId, tokens] of Object.entries(currentBalances)) {
      for (const token of Object.keys(tokens)) {
        const pendingRebalanceAmount = pendingRebalances[chainId]?.[token] ?? bnZero;
        currentBalances[chainId][token] = currentBalances[chainId][token].add(pendingRebalanceAmount);
        if (!pendingRebalanceAmount.eq(bnZero)) {
          logger.debug({
            at: "index.ts:runRebalancer",
            message: `${pendingRebalanceAmount.gt(bnZero) ? "Added" : "Subtracted"} pending rebalance amount from ${
              adapter.constructor.name
            } of ${pendingRebalanceAmount.toString()} to current balance for ${token} on ${chainId}`,
            pendingRebalanceAmount: pendingRebalanceAmount.toString(),
            newCurrentBalance: currentBalances[chainId][token].toString(),
          });
        }
      }
    }
  }
  logger.debug({
    at: "index.ts:runRebalancer",
    message: "Completed updating rebalance statuses and loading pending rebalances",
    duration: performance.now() - timerStart,
  });
  timerStart = performance.now();

  // Finally, send out new rebalances:
  try {
    // Resync balances
    // Execute rebalances
    if (process.env.SEND_REBALANCES === "true") {
      await rebalancerClient.rebalanceInventory(currentBalances);
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

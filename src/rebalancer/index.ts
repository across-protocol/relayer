/**
 * @notice This file is not designed to be run in production. I have been using it as an entrypoint to test out the
 * main `RebalancerClient` logic.
 */

import {
  BigNumber,
  bnZero,
  CHAIN_IDs,
  config,
  disconnectRedisClients,
  getTokenInfoFromSymbol,
  Signer,
  toBNWei,
  winston,
} from "../utils";
import { BinanceStablecoinSwapAdapter } from "./adapters/binance";
import { CctpAdapter } from "./adapters/cctpAdapter";
import { HyperliquidStablecoinSwapAdapter } from "./adapters/hyperliquid";
import { OftAdapter } from "./adapters/oftAdapter";
import { RebalancerAdapter, RebalancerClient, RebalanceRoute, TargetBalanceConfig } from "./rebalancer";
import { RebalancerConfig } from "./RebalancerConfig";
config();
let logger: winston.Logger;

export async function runRebalancer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  logger = _logger;
  const currentBalances: { [chainId: number]: { [token: string]: BigNumber } } = {
    1: {
      USDT: toBNWei("12", 6),
      USDC: toBNWei("0", 6),
    },
    10: {
      USDC: toBNWei("0", 6),
      USDT: toBNWei("0", 6),
    },
    42161: {
      USDT: toBNWei("12", 6),
      USDC: toBNWei("0", 6),
    },
    999: {
      USDT: toBNWei("0", 6),
      USDC: toBNWei("0", 6),
    },
    8453: {
      USDC: toBNWei("0", 6),
    },
    130: {
      USDC: toBNWei("0", 6),
      USDT: toBNWei("0", 6),
    },
    143: {
      USDC: toBNWei("0", 6),
      USDT: toBNWei("0", 6),
    },
    56: {
      USDT: toBNWei("0", 18),
      USDC: toBNWei("12", 18),
    },
  };

  const targetBalances: TargetBalanceConfig = {
    USDT: {
      "1": { targetBalance: toBNWei("0", 6), priorityTier: 0 },
      "10": { targetBalance: toBNWei("0", 6), priorityTier: 1 },
      "143": { targetBalance: toBNWei("0", 6), priorityTier: 1 },
      "42161": { targetBalance: toBNWei("0", 6), priorityTier: 1 },
      "999": { targetBalance: toBNWei("0", 6), priorityTier: 1 },
      "130": { targetBalance: toBNWei("0", 6), priorityTier: 1 },
      "56": { targetBalance: toBNWei("10.1", 18), priorityTier: 1 },
    },
    USDC: {
      "1": { targetBalance: bnZero, priorityTier: 0 },
      "10": { targetBalance: toBNWei("0", 6), priorityTier: 1 },
      "130": { targetBalance: toBNWei("0", 6), priorityTier: 1 },
      "143": { targetBalance: toBNWei("0", 6), priorityTier: 1 },
      "42161": { targetBalance: toBNWei("0", 6), priorityTier: 1 },
      "999": { targetBalance: toBNWei("10", 6), priorityTier: 1 },
      "8453": { targetBalance: toBNWei("0", 6), priorityTier: 1 },
      "56": { targetBalance: toBNWei("0", 18), priorityTier: 1 },
    },
  };
  const rebalancerConfig = new RebalancerConfig(process.env, targetBalances);

  // Construct adapters:
  const hyperliquidAdapter = new HyperliquidStablecoinSwapAdapter(logger, rebalancerConfig, baseSigner);
  const binanceAdapter = new BinanceStablecoinSwapAdapter(logger, rebalancerConfig, baseSigner);
  const cctpAdapter = new CctpAdapter(logger, rebalancerConfig, baseSigner);
  const oftAdapter = new OftAdapter(logger, rebalancerConfig, baseSigner);

  const adapters = { oft: oftAdapter, cctp: cctpAdapter, hyperliquid: hyperliquidAdapter, binance: binanceAdapter };

  // Following two variables are hardcoded to aid testing:
  const usdtChains = [
    CHAIN_IDs.HYPEREVM,
    CHAIN_IDs.ARBITRUM,
    CHAIN_IDs.OPTIMISM,
    CHAIN_IDs.MAINNET,
    CHAIN_IDs.UNICHAIN,
    CHAIN_IDs.MONAD,
    // CHAIN_IDs.BASE, // This shouldn't work and should fail on initialization
    CHAIN_IDs.BSC,
  ];
  const usdcChains = [
    CHAIN_IDs.HYPEREVM,
    CHAIN_IDs.ARBITRUM,
    CHAIN_IDs.OPTIMISM,
    CHAIN_IDs.MAINNET,
    CHAIN_IDs.BASE,
    CHAIN_IDs.UNICHAIN,
    CHAIN_IDs.MONAD,
    CHAIN_IDs.BSC,
  ];
  const rebalanceRoutes: RebalanceRoute[] = [];
  for (const usdtChain of usdtChains) {
    for (const usdcChain of usdcChains) {
      for (const adapter of ["binance", "hyperliquid"]) {
        // Handle exceptions:
        if (adapter !== "binance" && (usdtChain === CHAIN_IDs.BSC || usdcChain === CHAIN_IDs.BSC)) {
          continue;
        }
        const sourceUsdtInfo = getTokenInfoFromSymbol("USDT", usdtChain);
        const sourceUsdcInfo = getTokenInfoFromSymbol("USDC", usdcChain);
        const maxAmountToTransfer = "10.5";

        rebalanceRoutes.push({
          sourceChain: usdtChain,
          sourceToken: "USDT",
          destinationChain: usdcChain,
          destinationToken: "USDC",
          maxAmountToTransfer: toBNWei(maxAmountToTransfer, sourceUsdtInfo.decimals),
          adapter,
        });
        rebalanceRoutes.push({
          sourceChain: usdcChain,
          sourceToken: "USDC",
          destinationChain: usdtChain,
          destinationToken: "USDT",
          maxAmountToTransfer: toBNWei(maxAmountToTransfer, sourceUsdcInfo.decimals),
          adapter,
        });
      }
    }
  }

  const rebalancerClient = new RebalancerClient(logger, rebalancerConfig, adapters, rebalanceRoutes, baseSigner);
  let timerStart = performance.now();
  await rebalancerClient.initialize();
  logger.debug({
    at: "index.ts:runRebalancer",
    message: "Completed RebalancerClient initialization",
    duration: performance.now() - timerStart,
  });

  // Update all adapter order statuses so we can get the most accurate latest balances, and then query their balances.
  const adaptersToUpdate: Set<RebalancerAdapter> = new Set(Object.values(adapters));
  for (const adapter of adaptersToUpdate) {
    timerStart = performance.now();
    await adapter.updateRebalanceStatuses();
    logger.debug({
      at: "index.ts:runRebalancer",
      message: `Completed updating rebalance statuses for adapter ${adapter.constructor.name}`,
      duration: performance.now() - timerStart,
    });
  }

  for (const adapter of adaptersToUpdate) {
    // Modify all current balances with the pending rebalances:
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
    message: "Net current balances",
    currentBalances: Object.entries(currentBalances).map(([chainId, tokens]) => ({
      [chainId]: Object.fromEntries(Object.entries(tokens).map(([token, amount]) => [token, amount.toString()])),
    })),
  });

  // Finally, send out new rebalances:
  try {
    // Resync balances
    // Execute rebalances
    if (process.env.SEND_REBALANCES === "true") {
      timerStart = performance.now();
      await rebalancerClient.rebalanceInventory(currentBalances, toBNWei(process.env.MAX_FEE_PCT ?? "5", 18));
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

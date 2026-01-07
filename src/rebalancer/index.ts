import { CCTP_NO_DOMAIN, OFT_NO_EID, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import {
  BigNumber,
  bnZero,
  CHAIN_IDs,
  config,
  disconnectRedisClients,
  Signer,
  toBNWei,
  winston,
  BINANCE_NETWORKS,
  getCctpV2TokenMessenger,
} from "../utils";
import { BinanceStablecoinSwapAdapter } from "./adapters/binance";
import { HyperliquidStablecoinSwapAdapter } from "./adapters/hyperliquid";
import { RebalancerAdapter, RebalancerClient, RebalanceRoute, TargetBalanceConfig } from "./rebalancer";
import { RebalancerConfig } from "./RebalancerConfig";
import { PRODUCTION_NETWORKS } from "@across-protocol/contracts";
import { EVM_OFT_MESSENGERS } from "../common/Constants";
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
      USDC: toBNWei("0", 6),
      USDT: toBNWei("0", 6),
    },
    42161: {
      USDT: toBNWei("0", 6),
      USDC: toBNWei("0", 6),
    },
    999: {
      USDT: toBNWei("0", 6),
      USDC: toBNWei("20", 6),
    },
    8453: {
      USDC: toBNWei("0", 6),
      USDT: toBNWei("0", 6),
    },
  };

  const targetBalances: TargetBalanceConfig = {
    USDT: {
      "1": { targetBalance: bnZero, priorityTier: 0 },
      "10": { targetBalance: toBNWei("0", 6), priorityTier: 1 },
      "42161": { targetBalance: toBNWei("0", 6), priorityTier: 1 },
      "999": { targetBalance: toBNWei("0", 6), priorityTier: 1 },
      "8453": { targetBalance: toBNWei("10", 6), priorityTier: 1 },
    },
    USDC: {
      "1": { targetBalance: bnZero, priorityTier: 0 },
      "10": { targetBalance: toBNWei("0", 6), priorityTier: 1 },
      "42161": { targetBalance: toBNWei("0", 6), priorityTier: 1 },
      "999": { targetBalance: toBNWei("0", 6), priorityTier: 1 },
      "8453": { targetBalance: toBNWei("0", 6), priorityTier: 1 },
    },
  };
  const rebalancerConfig = new RebalancerConfig(process.env, targetBalances);

  // Construct adapters:
  const hyperliquidAdapter = new HyperliquidStablecoinSwapAdapter(logger, rebalancerConfig, baseSigner);
  const binanceAdapter = new BinanceStablecoinSwapAdapter(logger, rebalancerConfig, baseSigner);

  const adapters = { hyperliquid: hyperliquidAdapter, binance: binanceAdapter };

  // Initialize list of rebalance routes:
  const rebalanceRoutes: RebalanceRoute[] = [];

  // Following two variables are hardcoded to aid testing:
  const maxAmountToTransfer = toBNWei("10", 6);
  const chains = [
    CHAIN_IDs.OPTIMISM,
    CHAIN_IDs.ARBITRUM,
    CHAIN_IDs.BSC,
    CHAIN_IDs.MAINNET,
    CHAIN_IDs.BASE,
    CHAIN_IDs.HYPEREVM,
  ];

  // Construct rebalance routes for all pairs of chains:
  chains.forEach((usdtChain) => {
    chains.forEach((usdcChain) => {
      if (usdtChain === usdcChain) {
        return;
      }
      // SVM logic currently unsupported
      if (usdcChain === CHAIN_IDs.SOLANA || usdtChain === CHAIN_IDs.SOLANA) {
        return;
      }
      // Chain must either have an OFT, CCTP, or Binance entrypoint
      for (const chainId of [usdtChain, usdcChain]) {
        if (
          !BINANCE_NETWORKS[chainId] &&
          (PRODUCTION_NETWORKS[chainId].oftEid === OFT_NO_EID ||
            !EVM_OFT_MESSENGERS.get(TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET])?.has(chainId)) &&
          (PRODUCTION_NETWORKS[chainId].cctpDomain === CCTP_NO_DOMAIN ||
            !getCctpV2TokenMessenger(chainId)?.address !== undefined)
        ) {
          return;
        }
      }
      // Both source and destination chains have an OFT, CCTP, or Binance entrypoint, so we can rebalance between them
      rebalanceRoutes.push({
        sourceChain: usdtChain,
        sourceToken: "USDT",
        destinationChain: usdcChain,
        destinationToken: "USDC",
        maxAmountToTransfer,
        adapter: "binance",
      });
      rebalanceRoutes.push({
        sourceChain: usdcChain,
        sourceToken: "USDC",
        destinationChain: usdtChain,
        destinationToken: "USDT",
        maxAmountToTransfer,
        adapter: "binance",
      });
    });
  });

  const rebalancerClient = new RebalancerClient(logger, rebalancerConfig, adapters, rebalanceRoutes, baseSigner);
  let timerStart = performance.now();
  await rebalancerClient.initialize();
  logger.debug({
    at: "index.ts:runRebalancer",
    message: "Completed RebalancerClient initialization",
    duration: performance.now() - timerStart,
  });

  // Update all adapter order statuses so we can get the most accurate latest balances:
  const adaptersToUpdate: Set<RebalancerAdapter> = new Set(rebalanceRoutes.map((x) => adapters[x.adapter]));
  for (const adapter of adaptersToUpdate) {
    timerStart = performance.now();
    await adapter.updateRebalanceStatuses();
    logger.debug({
      at: "index.ts:runRebalancer",
      message: `Completed updating rebalance statuses for adapter ${adapter.constructor.name}`,
      duration: performance.now() - timerStart,
    });

    // // There should probably be a delay between the above and `getPendingRebalances` to allow for any newly transmitted
    // // transactions to get mined.
    // await delay(5);

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

  // Finally, send out new rebalances:
  try {
    // Resync balances
    // Execute rebalances
    if (process.env.SEND_REBALANCES === "true") {
      timerStart = performance.now();
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

import {
  BigNumber,
  bnUint256Max,
  bnUint32Max,
  bnZero,
  config,
  delay,
  disconnectRedisClients,
  Signer,
  toBNWei,
  winston,
} from "../utils";
import { BinanceStablecoinSwapAdapter } from "./adapters/binance";
import { HyperliquidStablecoinSwapAdapter } from "./adapters/hyperliquid";
import { RebalancerAdapter, RebalancerClient, RebalanceRoute, TargetBalanceConfig } from "./rebalancer";
import { RebalancerConfig } from "./RebalancerConfig";
config();
let logger: winston.Logger;

export async function runRebalancer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  logger = _logger;
  const currentBalances: { [chainId: number]: { [token: string]: BigNumber } } = {
    // 1: {
    //   USDT: toBNWei("20", 6),
    //   USDC: toBNWei("20", 6),
    // },
    10: {
      USDT: toBNWei("0", 6),
    },
    42161: {
      USDC: toBNWei("20", 6),
    },
  };

  const targetBalances: TargetBalanceConfig = {
    USDT: {
      // "1": { targetBalance: bnUint256Max, priorityTier: 0 },
      "10": { targetBalance: toBNWei("10.3", 6), priorityTier: 1 },
    },
    USDC: {
      // "1": { targetBalance: bnUint32Max, priorityTier: 0 },
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
    // {
    //   sourceChain: 42161,
    //   destinationChain: 1,
    //   sourceToken: "USDC",
    //   destinationToken: "USDT",
    //   maxAmountToTransfer: toBNWei("5.5", 6),
    //   adapter: "binance",
    // },
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
    // {
    //   sourceChain: 42161,
    //   sourceToken: "USDC",
    //   destinationChain: 10,
    //   destinationToken: "USDT",
    //   maxAmountToTransfer: toBNWei("10.3", 6),
    //   adapter: "binance",
    // },
    {
      sourceChain: 42161,
      sourceToken: "USDC",
      destinationChain: 10,
      destinationToken: "USDT",
      maxAmountToTransfer: toBNWei("10.3", 6),
      adapter: "hyperliquid",
    },
  ];
  const rebalancerClient = new RebalancerClient(logger, rebalancerConfig, adapters, rebalanceRoutes, baseSigner);
  await rebalancerClient.initialize();
  console.log("rebalancer initialized");

  // Next test I should run:
  // - Update for order status updates
  // - Place a new rebalance, check that it saves into Redis correctly. Should now be marked PENDING_SWAP
  // - Run next loop:
  // - Check that once the order gets placed, the order status updates come in:
  //    - If it gets cancelled, attempt to replace it with the same OID. Can we reuse an OID?
  //    - If it gets filled, update its redis data and then bridge it back to HyperEVM. Status should now be PENDING_BRIDGE_TO_DESTINATION_CHAIN
  //        - Save the withdrawal under pending withdrawals from hypercore.
  //        - On next loop, check for withdrawal completion, and then once it settles, delete order from redis.

  // The next iteration is to read balances on hyperevm and to issue rebalance when necessary.

  // Next, add CCTP routes as the source chain and check that order statuses update correctly.

  // Next, read across chain balances to trigger the CCTP routes

  // Follow that with CCTP routes as destination chain.

  // Update all adapter order statuses so we can get the most accurate latest balances:
  const adaptersToUpdate: Set<RebalancerAdapter> = new Set(rebalanceRoutes.map((x) => adapters[x.adapter]));
  for (const adapter of adaptersToUpdate) {
    console.log(`Updating rebalance statuses for adapter ${adapter.constructor.name}`);
    await adapter.updateRebalanceStatuses();

    // // There should probably be a delay between the above and `getPendingRebalances` to allow for any newly transmitted
    // // transactions to get mined.
    // await delay(5);

    // Modify all current balances with the pending rebalances:
    const pendingRebalances = await adapter.getPendingRebalances();
    for (const [chainId, tokens] of Object.entries(currentBalances)) {
      for (const token of Object.keys(tokens)) {
        const pendingRebalanceAmount = pendingRebalances[chainId]?.[token] ?? bnZero;
        currentBalances[chainId][token] = currentBalances[chainId][token].add(pendingRebalanceAmount);
        logger.debug({
          message: `Updated current balance for ${token} on ${chainId} using pending rebalances on ${adapter.constructor.name}`,
          existingCurrentBalance: currentBalances[chainId][token].sub(pendingRebalanceAmount).toString(),
          virtualBalanceCreditOrDeficit: pendingRebalanceAmount.toString(),
          newCurrentBalance: currentBalances[chainId][token].toString(),
        });
      }
    }
  }

  // Finally, send out new rebalances:
  try {
    // Resync balances
    // Execute rebalances
    if (process.env.SEND_REBALANCES === "true") {
      await rebalancerClient.rebalanceInventory(currentBalances);
      console.log("rebalancer sent rebalances");
    }
    // Maybe now enter a loop where we update rebalances continuously every X seconds until the next run where
    // we call rebalance inventory? The thinking is we should rebalance inventory once per "run" and then continually
    // update rebalance statuses/finalize pending rebalances.
  } catch (error) {
    console.error("Error running rebalancer", error);
  } finally {
    await disconnectRedisClients(logger);
  }
}

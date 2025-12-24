import { BigNumber, config, disconnectRedisClients, Signer, startupLogLevel, toBNWei, winston } from "../utils";
import { BinanceStablecoinSwapAdapter } from "./adapters/binance";
import { HyperliquidStablecoinSwapAdapter } from "./adapters/hyperliquid";
import { RebalancerClient, RebalanceRoute } from "./rebalancer";
import { RebalancerConfig } from "./RebalancerConfig";
config();
let logger: winston.Logger;

export async function runRebalancer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  logger = _logger;
  const config = new RebalancerConfig(process.env);

  // Construct adapters:
  const hyperliquidAdapter = new HyperliquidStablecoinSwapAdapter(logger, config, baseSigner);
  const binanceAdapter = new BinanceStablecoinSwapAdapter(logger, config, baseSigner);

  const adapters = { hyperliquid: hyperliquidAdapter, binance: binanceAdapter };

  // Initialize list of rebalance routes:
  const rebalanceRoutes: RebalanceRoute[] = [
    // {
    //   sourceChain: 999,
    //   destinationChain: 999,
    //   sourceToken: "USDT",
    //   destinationToken: "USDC",
    //   maxAmountToTransfer: toBNWei("10.22", 6),
    //   adapter: "hyperliquid",
    // },
    {
      sourceChain: 8453,
      destinationChain: 42161,
      sourceToken: "USDC",
      destinationToken: "USDT",
      maxAmountToTransfer: toBNWei("10.3", 6),
      adapter: "binance",
    },
  ];

  const rebalancerClient = new RebalancerClient({}, adapters, rebalanceRoutes, baseSigner);
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
  await binanceAdapter.updateRebalanceStatuses();
  console.log("binanceAdapter updated order statuses");
  // await hyperliquidAdapter.updateRebalanceStatuses();
  // console.log("hyperliquidAdapter updated order statuses");

  // There should probably be a delay between the above and `getPendingRebalances` to allow for any newly transmitted
  // transactions to get mined.
  // await hyperliquidAdapter.getPendingRebalances(rebalanceRoutes[0]);
  // console.log("hyperliquidAdapter got pending rebalances");
  await binanceAdapter.getPendingRebalances(rebalanceRoutes[0]);
  console.log("binanceAdapter got pending rebalances");

  // Finally, send out new rebalances:
  try {
    // Resync balances
    // Execute rebalances
    await rebalancerClient.rebalanceInventory();
    console.log("rebalancer sent rebalances");
    // Maybe now enter a loop where we update rebalances continuously every X seconds until the next run where
    // we call rebalance inventory? The thinking is we should rebalance inventory once per "run" and then continually
    // update rebalance statuses/finalize pending rebalances.
  } catch (error) {
    console.error("Error running rebalancer", error);
  } finally {
    await disconnectRedisClients(logger);
  }
}

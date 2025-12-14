import { config, disconnectRedisClients, Signer, startupLogLevel, toBNWei, winston } from "../utils";
import { HyperliquidStablecoinSwapAdapter } from "./adapters/hyperliquid";
import { RebalancerClient } from "./rebalancer";
import { RebalancerConfig } from "./RebalancerConfig";
config();
let logger: winston.Logger;

export async function runRebalancer(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  logger = _logger;
  const config = new RebalancerConfig(process.env);
  const hyperliquidAdapter = new HyperliquidStablecoinSwapAdapter(baseSigner);
  const rebalancerClient = new RebalancerClient(
    {},
    { hyperliquid: hyperliquidAdapter },
    [
      {
        sourceChain: 999,
        destinationChain: 42161,
        sourceToken: "USDC",
        destinationToken: "USDT",
        maxAmountToTransfer: toBNWei("1", 6),
        adapter: "hyperliquid",
      },
    ],
    baseSigner
  );
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

  // Start polling. This probably will go in the rebalancerClient.initialize() loop.
  await hyperliquidAdapter.updateRebalanceStatuses();
  console.log("hyperliquidAdapter updated order statuses");

  try {
      // Resync balances
      // Execute rebalances
        // await rebalancerClient.rebalanceInventory();
        // console.log("rebalancer sent rebalances")
  } catch (error) {
    console.error("Error running rebalancer", error);
  } finally {
    await disconnectRedisClients(logger);
  }
}

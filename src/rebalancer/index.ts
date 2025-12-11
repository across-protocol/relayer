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
        sourceChain: 8453,
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
  await hyperliquidAdapter.pollForRebalanceCompletion();

  try {
    do {
      // Resync balances
      // Execute rebalances
      // Delay for some time before next loop.
      // eslint-disable-next-line no-constant-condition
    } while (true);
  } catch (error) {
    console.error("Error running rebalancer", error);
  } finally {
    await disconnectRedisClients(logger);
  }
}

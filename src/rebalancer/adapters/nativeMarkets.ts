import { RedisClient } from "../../caching/RedisCache";
import { RebalancerAdapter, RebalanceRoute } from "../rebalancer";

// enum STATUS {
//   PENDING_TRANSFER_TO_ARBITRUM,
//   PENDING_TRANSFER_TO_HYPEREVM,
// }

// Only used to move USDC from any chain through Arbitrum USDC and then to HyperEVM USDH.
export class NativeMarketsRebalancerAdapter implements RebalancerAdapter {
  // Keep track of rebalances which require multiple steps:
  // 1) Sending USDC to arbitrum
  // 2) Sending USDC through native markets API to USDH
  redisClient: RedisClient;

  async initialize(): Promise<void> {
    // TODO
  }

  async initializeRebalance(): Promise<void> {
    // If source token is not USDC, throw.
    // If origin chain is Arbitrum, call native markets API and save rebalance to Redis with status PENDING_TRANSFER_TO_ARBITRUM
    // Otherwise, initiate CCTP transfer and save rebalance to Redis with status PENDING_TRANSFER_TO_HYPEREVM.
  }

  async pollForRebalanceCompletion(): Promise<void> {
    // For any rebalances with status PENDING_TRANSFER_TO_ARBITRUM, check if transfer has completed to Arbitrum
    // and then call native markets API and update status to PENDING_TRANSFER_TO_HYPEREVM.
    // For any rebalances with status PENDING_TRANSFER_TO_HYPEREVM, check if transfer has completed to HyperEVM
    // and then delete pending rebalance.
  }

  getPendingRebalances(): Promise<RebalanceRoute[]> {
    // TODO
    return Promise.resolve([]);
  }
}

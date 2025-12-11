import { RedisClient } from "../../caching/RedisCache";
import { RebalancerAdapter, RebalanceRoute } from "../rebalancer";

enum STATUS {
    PENDING_BRIDGE_TO_HYPEREVM,
    PENDING_SWAP,
    PENDING_BRIDGE_TO_DESTINATION_CHAIN
}

// This adapter can be used to swap stables in Hyperliquid
export class HyperliquidStablecoinSwapAdapter implements RebalancerAdapter {
    private redisClient: RedisClient;
    
    constructor() {
      // TODO
    }
  
    async initializeRebalance(rebalanceRoute: RebalanceRoute): Promise<void> {
        // If source token is not USDC, USDT, or USDH, throw.
        // If destination token is same as source token, throw.
        // If source token is USDH then throw if source chain is not HyperEVM.
        // If source chain is not HyperEVM, then initiate CCTP/OFT transfer to HyperEVN and save order
        //     with status PENDING_BRIDGE_TO_HYPEREVM.
        // Else source chain is HyperEVM, so atomically deposit into Hypercore and place order for destination token,
        //     and save order with status PENDING_SWAP. Call _depositToHypercoreAndPlaceOrder().
    }
  
    async finalizeRebalance(): Promise<void> {
      // For all orders with status PENDING_BRIDGE_TO_HYPEREVM, check if transfer has completed to HyperEVM, and if
      // it has then call _depositToHypercoreAndPlaceOrder(). Save the order with status PENDING_SWAP.

      // For all orders with status PENDING_SWAP, check if order has been filled, and if it has then call
      // _withdrawToHyperevm() and save order with status PENDING_WITHDRAWAL_TO_DESTINATION_CHAIN.

      // For all orders PENDING_BRIDGE_TO_DESTINATION_CHAIN, check if HyperEVM balance is sufficient and then
      // initiate CCTP/OFT transfer to destination chain, and then delete order.
      }

    private _depositToHypercoreAndPlaceOrder(rebalanceRoute: RebalanceRoute): Promise<void> {
      // For USDC, we need a contract that calls special CoreDepositWallet contract and then places an order on
      // HyperCore.

      // For other ERC20's, we need a contract that deposits into Hypercore and then places an order on Hypercore.
    }

    private _withdrawToHyperevm(rebalanceRoute: RebalanceRoute): Promise<void> {
      // TODO
    }
  
    getPendingRebalances(): Promise<RebalanceRoute[]> {
      return Promise.resolve([]);
    }
  }
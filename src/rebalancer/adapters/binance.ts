import { Binance } from "binance-api-node";
import { BigNumber, getBinanceApiClient, Signer, winston } from "../../utils";
import { RebalancerAdapter, RebalanceRoute } from "../rebalancer";
import { RebalancerConfig } from "../RebalancerConfig";

enum STATUS {
  PENDING_DEPOSIT,
  PENDING_SWAP,
  PENDING_WITHDRAWAL,
}

export class BinanceStablecoinSwapAdapter implements RebalancerAdapter {
  private binanceApiClient: Binance;
  constructor(readonly logger: winston.Logger, readonly config: RebalancerConfig, readonly baseSigner: Signer) {}
  async initialize(availableRoutes: RebalanceRoute[]): Promise<void> {
    this.binanceApiClient = await getBinanceApiClient(process.env.BINANCE_API_BASE);
  }
  async initializeRebalance(rebalanceRoute: RebalanceRoute): Promise<void> {
    // Transfer to Binance using depositAddress for coin.
  }
  async updateRebalanceStatuses(): Promise<void> {
    // Check for open orders. If they match with fills, withdraw them. If there are no open orders
    // matching with cloids, then replace them.
    // For any orders with pending withdrawal status, check if they have finalized and then delete them if they have.
  }

  // Get all currently unfinalized rebalance amounts. Should be used to add a virtual balance credit for the chain
  // + token in question.
  async getPendingRebalances(rebalanceRoute: RebalanceRoute): Promise<{ [chainId: number]: BigNumber }> {
    return {};
    // For any orders with pending status add virtual balance to destination chain.
    // For orders with pending withdrawal status, check if they have finalized.
  }
}

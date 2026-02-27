export type ExcessOrDeficit = { token: string; chainId: number; amount: BigNumber; priorityTier: number };
// Excesses are always sorted in priority from lowest to highest and then by amount from largest to smallest.

export interface RebalancerAdapter {
  initialize(availableRoutes: RebalanceRoute[]): Promise<void>;
  initializeRebalance(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<void>;
  updateRebalanceStatuses(): Promise<void>;
  sweepIntermediateBalances(): Promise<void>;

  // Get all currently unfinalized rebalance amounts. Should be used to add a virtual balance credit for the chain
  // + token in question.
  getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }>;
  getPendingOrders(): Promise<string[]>;
  getEstimatedCost(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber, debugLog: boolean): Promise<BigNumber>;
}

export interface RebalanceRoute {
  sourceChain: number;
  destinationChain: number;
  sourceToken: string;
  destinationToken: string;
  adapter: string; // Name of adapter to use for this rebalance.
}

export interface RebalancerClient {
  getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }>;
}

import { BigNumber, EvmAddress } from "../../utils";

export type ExcessOrDeficit = { token: string; chainId: number; amount: BigNumber; priorityTier: number };

export interface RebalancerAdapter {
  baseSignerAddress: EvmAddress;
  initialize(availableRoutes: RebalanceRoute[]): Promise<void>;
  setApprovals(): Promise<void>;
  initializeRebalance(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<BigNumber>;
  updateRebalanceStatuses(): Promise<void>;
  sweepIntermediateBalances(): Promise<void>;

  // Get all currently unfinalized rebalance amounts. Should be used to add a virtual balance credit for the chain
  // + token in question.
  getPendingRebalances(account: EvmAddress): Promise<{ [chainId: number]: { [token: string]: BigNumber } }>;
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
  adapters: Record<string, RebalancerAdapter>;
  getPendingRebalances(account: EvmAddress): Promise<{ [chainId: number]: { [token: string]: BigNumber } }>;
  // Names of adapters whose most recent getPendingRebalances() read threw and was treated as empty. Writers must
  // not initiate new rebalances while this is non-empty: the failed adapter's in-flight rebalances are invisible
  // to virtual balances, so an apparent deficit may already be covered.
  getAdaptersWithFailedPendingReads(): string[];
}

export interface OrderDetails {
  sourceToken: string;
  destinationToken: string;
  sourceChain: number;
  destinationChain: number;
  amountToTransfer: BigNumber;
}

export interface RedisOrderDetailsPayload {
  sourceToken: string;
  destinationToken: string;
  sourceChain: number;
  destinationChain: number;
  amountToTransfer: string;
}

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

  // Get the source-token amounts of orders in PENDING_DEPOSIT status, keyed by source chain and token
  // (denominated in source-chain token decimals). These funds are in flight to — or already credited on — the
  // venue and must remain available for the order to progress, so balance-based sweepers (e.g. the Binance
  // finalizer) should deduct them from any withdrawable-balance calculation.
  getPendingDepositSourceAmounts(account: EvmAddress): Promise<{ [chainId: number]: { [token: string]: BigNumber } }>;
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
  getPendingRebalances(account: EvmAddress): Promise<{ [chainId: number]: { [token: string]: BigNumber } }>;
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

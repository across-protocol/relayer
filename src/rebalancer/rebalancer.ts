import { BigNumber } from "../utils";

interface ChainConfig {
  // This should be possible to set to 0 (to indicate that a chain should hold zero funds) or
  // positive infinity (to indicate that a chain should be the universal sink for the given token).
  targetBalance: BigNumber;
}

interface TokenConfig {
  [chainId: number]: ChainConfig;
}

interface RebalancerConfig {
  [token: string]: TokenConfig;
}

interface ChainAllocation {
  currentBalance: BigNumber;
}

interface TokenAllocation {
  [token: string]: ChainAllocation;
}

interface RebalancerAllocation {
  [token: string]: TokenAllocation;
}

export interface RebalanceRoute {
  sourceChain: number;
  destinationChain: number;
  sourceToken: string;
  destinationToken: string;
  maxAmountToTransfer: BigNumber; // Should this be a nornmalized value or in the units of the destination token on the 
  // destination chain?
  fee: BigNumber;
}

/**
 * @notice This class is a successor to the InventoryClient. It is in charge of rebalancing inventory of the user
 * across all chains given the current and configured target allocations.
 */
export class RebalancerClient {

  // private rebalancesRoutes: { [token: string]: { [chainId: number]: RebalanceRoute[] } } = {};

  constructor(readonly config: RebalancerConfig) {
    // TODO
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async rebalanceInventory(currentAllocations: RebalancerAllocation): Promise<void> {
    // Setup:
    // - For each adapter:
    //   - Call finalizeRebalances() to sweep up any pending rebalances.
    // - For each token:
    //   - Load all current balances per chain, including spot balances, pending rebalances, shortfalls, etc, and
    //     store in memory within this function.
    // Run:
    // - For each token:
    // - Filter all chains that are UNDER target balance and sort by largest deficit.
    // - For each chain, query all rebalance routes TO the current chain that have an "excess" balance 
    //   large enough to cover the deficit (excess = current balance - target balance).
    //    - Note: This should include both swap and bridge routes, so you could theoretically fill deficits in USDC using
    //      by drawing from excesses in USDT.
    // - If resultant route list is empty, log a warning.
    // - Otherwise, enqueue calldata for the rebalance route to execute, and decrement the current balance for
    //   the source chain so we don't overdraw the source chain when trying to rebalance to another chain.
  }

  async getCurrentAllocations(): Promise<RebalancerAllocation> {
    // TODO
    return Promise.resolve({});
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getRebalanceRoutesToChain(chain: number, token: string, amountToTransfer: BigNumber): RebalanceRoute[] {
    // TODO:
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async executeRebalance(rebalanceRoute: RebalanceRoute): Promise<void> {
    // TODO:
    // - Call adapter for specific rebalacne route.
  }

  async getPendingRebalances(): Promise<RebalanceRoute[]> {
    return Promise.resolve([]);
  }
}

export interface RebalancerAdapter {
  // Callable by RebalancerClient. Initializes a specific rebalance.
  initializeRebalance(rebalanceRoute: RebalanceRoute): Promise<void>;
  // Callable by anyone, finalizes all pending rebalances lazily. Rebalances might have more than 2 steps, so we should
  // always call this function before reading getPendingRebalances().
  finalizeRebalances(): Promise<void>;

  // Get all currently unfinalized rebalances.
  getPendingRebalances(): Promise<RebalanceRoute[]>;
}
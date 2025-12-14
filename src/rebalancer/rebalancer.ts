import { BigNumber, Signer } from "../utils";

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
  adapter: string; // Name of adapter to use for this rebalance.
}

/**
 * @notice This class is a successor to the InventoryClient. It is in charge of rebalancing inventory of the user
 * across all chains given the current and configured target allocations.
 */
export class RebalancerClient {
  constructor(
    readonly config: RebalancerConfig,
    readonly adapters: { [name: string]: RebalancerAdapter },
    readonly rebalanceRoutes: RebalanceRoute[],
    readonly baseSigner: Signer
  ) {}

  async initialize(): Promise<void> {
    for (const [name, adapter] of Object.entries(this.adapters)) {
      await adapter.initialize(this.rebalanceRoutes);
      console.log(`Initialized adapter: ${name}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async rebalanceInventory(): Promise<void> {
    const hyperliquidRoute = this.rebalanceRoutes.find((route) => route.adapter === "hyperliquid");
    if (hyperliquidRoute) {
      console.log(`Initializing rebalance for route: ${JSON.stringify(hyperliquidRoute)}`);
      await this.adapters.hyperliquid.initializeRebalance(hyperliquidRoute);
    }
    // Setup:
    // - We can only rebalance via rebalance routes from source chains + tokens to destination chains + tokens.
    // - From the rebalance route list, load all chains and tokens we need to query:
    //   - Set of all source chains + source tokens
    //   - Set of all destination chains + destination tokens
    // - For each chain + token:
    //   - Load all current balances per chain including pending rebalances.
    //   - We should define these balances in $ terms to normalize them, therefore we'll need a price oracle for each token.
    // Run:
    // - Identify list of source chains that have EXCESS balances.
    // - Identify list of destination chains that have DEFICIT balances.
    // - Our goal is to attempt to send funds from excess balances to refill deficit balances.
    // - We do not attempt to reduce excess balances unless there is a deficit to refill. Absent anu deficits,
    //   excesses are ok.
    // - The user might find it helpful to define a chain as a "universal source" by setting its target balance to 0,
    //   therefore that chain always has an excess balance.
    // - Similarly, the user might find it helpful to define a "universal sink" by setting its target balance to positive
    //   infinity, therefore that chain always has a deficit balance.
    // - For each DEFICIT chain, query all rebalance routes TO that chain that have an "excess" balance
    //   large enough to cover the deficit (excess = current balance - target balance).
    //    - Note: This should include both swap and bridge routes, so you could theoretically fill deficits in USDC using
    //      by drawing from excesses in USDT.
    // - If resultant route list is empty, log a warning.
    // - Otherwise, call initializeRebalance() for that route.
    // - To avoid duplicate rebalances, the adapters should correctly implement getPendingRebalances() so that this
    //   client computes current balances correctly.
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
  initialize(availableRoutes: RebalanceRoute[]): Promise<void>;
  initializeRebalance(rebalanceRoute: RebalanceRoute): Promise<void>;
  updateRebalanceStatuses(): Promise<void>;

  // Get all currently unfinalized rebalances.
  getPendingRebalances(): Promise<RebalanceRoute[]>;
}

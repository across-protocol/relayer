import { BigNumber, getNetworkName, Signer, toBNWei, winston } from "../utils";

interface ChainConfig {
  // This should be possible to set to 0 (to indicate that a chain should hold zero funds) or
  // positive infinity (to indicate that a chain should be the universal sink for the given token).
  targetBalance: BigNumber;
  // Set this lower to prioritize returning this balance (if below target) back to target or deprioritize
  // sending this balance when above target.
  priorityTier: number;
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
    readonly logger: winston.Logger,
    readonly config: RebalancerConfig,
    readonly adapters: { [name: string]: RebalancerAdapter },
    readonly rebalanceRoutes: RebalanceRoute[],
    readonly baseSigner: Signer
  ) {}

  async initialize(): Promise<void> {
    for (const [name, adapter] of Object.entries(this.adapters)) {
      const routesForAdapter = this.rebalanceRoutes.filter((route) => route.adapter === name);
      await adapter.initialize(routesForAdapter);
      console.log(`Initialized ${name} adapter with routes:`, routesForAdapter);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async rebalanceInventory(/* maxCostBps: number */): Promise<void> {
    for (const rebalanceRoute of this.rebalanceRoutes) {
      this.logger.debug({
        at: "RebalanceClient.rebalanceInventory",
        message: `Initializing new rebalance from ${rebalanceRoute.sourceToken} on ${getNetworkName(
          rebalanceRoute.sourceChain
        )} to ${rebalanceRoute.destinationToken} on ${getNetworkName(rebalanceRoute.destinationChain)}`,
        amountToTransfer: rebalanceRoute.maxAmountToTransfer.toString(),
      });
      const expectedCostForRebalance = await this.adapters[rebalanceRoute.adapter].getEstimatedCost(rebalanceRoute);
      console.log(`Expected cost denominated in source tokens is ${expectedCostForRebalance.toString()}`);

      const amountToTransferWithFees = rebalanceRoute.maxAmountToTransfer.add(expectedCostForRebalance);
      console.log(`Amount to transfer with fees: ${amountToTransferWithFees.toString()}`);

      // const adjustedRebalanceRoute = { ...rebalanceRoute, maxAmountToTransfer: amountToTransferWithFees };
      // if (rebalanceRoute.adapter === "hyperliquid") {
      //   await this.adapters.hyperliquid.initializeRebalance(adjustedRebalanceRoute);
      // } else if (rebalanceRoute.adapter === "binance") {
      //   await this.adapters.binance.initializeRebalance(adjustedRebalanceRoute);
      // } else {
      //   throw new Error(`Adapter ${rebalanceRoute.adapter} not supported`);
      // }
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
    // - Otherwise, call initializeRebalance() for that route using the "cheapest" route whose cost is under the
    //   max allowable cost. We'll need to query route.adapter.getCostEstimate to figure out the cost of the route.
    // - To avoid duplicate rebalances, the adapters should correctly implement getPendingRebalances() so that this
    //   client computes current balances correctly.

    // for (const deficit of  deficits) {
    //   const routes = this.getRebalanceRoutesToChain(deficit.chain, deficit.token, deficit.amount);
    //   const cheapestRoute = routes.filter((route) => route.adapter.getCostEstimate(route) < maxCost).sort((a, b) => a.cost - b.cost)[0];
    //   await this.adapters.hyperliquid.initializeRebalance(cheapestRoute);
    // }
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

  // Get all currently unfinalized rebalance amounts. Should be used to add a virtual balance credit for the chain
  // + token in question.
  getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }>;
  getEstimatedCost(rebalanceRoute: RebalanceRoute): Promise<BigNumber>;
}

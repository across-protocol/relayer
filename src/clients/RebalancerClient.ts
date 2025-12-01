import { BigNumber } from "../utils";

interface ChainConfig {
  minimumBalance: BigNumber;
  maximumBalance: BigNumber;
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

interface RebalanceRoute {
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
  constructor(readonly config: RebalancerConfig) {
    // TODO
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async rebalanceInventory(currentAllocations: RebalancerAllocation): Promise<void> {
    // TODO:
    // Figure out which chain targets are under and over allocated, then for any over allocated chains,
    // attempt to send excess to chains with under allocations. We can only send tokens between chains that share
    // a rebalance route.
  }

  async getCurrentAllocations(): Promise<RebalancerAllocation> {
    // TODO
    return Promise.resolve({});
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getRebalanceRoutes(chain: number, token: string, amountToTransfer: BigNumber): RebalanceRoute[] {
    // TODO:
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async executeRebalance(rebalanceRoute: RebalanceRoute): Promise<void> {
    // TODO:
    // - Load rebalance route function from some adapter that we'll need to call.
  }

  async getPendingRebalances(): Promise<RebalanceRoute[]> {
    // TODO:
    // - Should we fetch this data fresh or should we cache pending rebalances in a data layer like Redis?
    return Promise.resolve([]);
  }
}

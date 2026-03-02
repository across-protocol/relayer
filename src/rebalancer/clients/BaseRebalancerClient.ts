import { RebalancerConfig } from "../RebalancerConfig";
import { BigNumber, bnZero, forEachAsync, Signer, winston } from "../../utils";
import { RebalancerAdapter, RebalancerClient, RebalanceRoute } from "../utils/interfaces";

/**
 * @notice This class is a successor to the InventoryClient. It is in charge of rebalancing inventory of the user
 * across all chains given the current and configured target allocations.
 * @dev Different concrete rebalancer clients can share this base while implementing different
 * inventory-rebalancing modes.
 */
export abstract class BaseRebalancerClient implements RebalancerClient {
  public rebalanceRoutes: RebalanceRoute[];
  constructor(
    readonly logger: winston.Logger,
    readonly config: RebalancerConfig,
    readonly adapters: { [name: string]: RebalancerAdapter },
    readonly baseSigner: Signer
  ) {}

  /**
   * @notice Pass in any rebalance routes that could be rebalanced over by this client. If constructing a read
   * only client, you can pass in zero routes.
   * @param rebalanceRoutes
   */
  async initialize(rebalanceRoutes: RebalanceRoute[]): Promise<void> {
    this.rebalanceRoutes = rebalanceRoutes;
    for (const adapter of Object.values(this.adapters)) {
      await adapter.initialize(this.rebalanceRoutes);
    }
  }

  abstract rebalanceInventory(...args: unknown[]): Promise<void>;

  /**
   * @notice Get all currently unfinalized rebalance amounts. Should be used to add virtual balance credits or
   * debits for the token and chain combinations.
   * @dev Does not depend on this.rebalanceRoutes, only calls getPendingRebalances() for each configured adapter.
   * @return Dictionary of chainId -> token -> amount where positive amounts present pending rebalance credits to that
   * chain while negative amounts represent debits that should be subtracted from that chain's current balance.
   */
  async getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }> {
    const pendingRebalances: { [chainId: number]: { [token: string]: BigNumber } } = {};
    await forEachAsync(Object.values(this.adapters), async (adapter) => {
      const pending = await adapter.getPendingRebalances();
      Object.entries(pending).forEach(([chainId, tokenBalance]) => {
        Object.entries(tokenBalance).forEach(([token, amount]) => {
          pendingRebalances[chainId] ??= {};
          pendingRebalances[chainId][token] = (pendingRebalances[chainId]?.[token] ?? bnZero).add(amount);
        });
      });
    });
    return pendingRebalances;
  }

  protected async getAvailableAdapters(): Promise<string[]> {
    // Check if there are already too many pending orders for this adapter.
    const availableAdapters: Set<string> = new Set();
    for (const adapter of Object.keys(this.adapters)) {
      const pendingOrders = await this.adapters[adapter].getPendingOrders();
      const maxPendingOrdersForAdapter = this.config.maxPendingOrders[adapter] ?? 2; // @todo Default low for now,
      // eventually change this to a very high default value.
      if (pendingOrders.length < maxPendingOrdersForAdapter) {
        availableAdapters.add(adapter);
      } else {
        this.logger.debug({
          at: "RebalanceClient.rebalanceInventory",
          message: `Too many pending orders (${pendingOrders.length}) for ${adapter} adapter, rejecting new rebalances`,
          maxPendingOrdersForAdapter,
        });
      }
    }
    return Array.from(availableAdapters);
  }
}

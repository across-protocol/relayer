import { RebalancerConfig } from "../RebalancerConfig";
import { assert, BigNumber, bnZero, EvmAddress, forEachAsync, Signer, winston, ZERO_ADDRESS } from "../../utils";
import { RebalancerAdapter, RebalancerClient, RebalanceRoute } from "../utils/interfaces";

/**
 * @notice This class is a successor to the InventoryClient. It is in charge of rebalancing inventory of the user
 * across all chains given the current and configured target allocations.
 * @dev Different concrete rebalancer clients can share this base while implementing different
 * inventory-rebalancing modes.
 */
export abstract class BaseRebalancerClient implements RebalancerClient {
  public rebalanceRoutes: RebalanceRoute[] = [];
  protected baseSignerAddress: EvmAddress = EvmAddress.from(ZERO_ADDRESS);
  protected pendingReadFailures: string[] = [];
  constructor(
    readonly logger: winston.Logger,
    readonly config: RebalancerConfig,
    readonly adapters: { [name: string]: RebalancerAdapter },
    readonly baseSigner: Signer,
    readonly isReadonly: boolean
  ) {}

  /**
   * @notice Pass in any rebalance routes that could be rebalanced over by this client. If constructing a read
   * only client, you can pass in zero routes.
   * @param rebalanceRoutes
   */
  async initialize(rebalanceRoutes: RebalanceRoute[]): Promise<void> {
    this.baseSignerAddress = EvmAddress.from(await this.baseSigner.getAddress());
    this.rebalanceRoutes = rebalanceRoutes;
    for (const adapter of Object.values(this.adapters)) {
      await adapter.initialize(this.rebalanceRoutes);
      // Adapters are considered to be a part of this rebalancer client so we should enforce that their baseSigners
      // are 1:1 aligned. This lets us assume that any rebalance initiated by this client and delegated to an adapter
      // uses the rebalancer client's base signer. Ultimately, the rebalancer client is the client exposed to
      // external users and that user would expect to initiate rebalances through this client's base signer.
      assert(
        adapter.baseSignerAddress.eq(this.baseSignerAddress),
        "Adapter base signer address does not match client base signer address"
      );
      if (!this.isReadonly) {
        await adapter.setApprovals();
      }
    }
  }

  abstract rebalanceInventory(...args: unknown[]): Promise<void>;

  /**
   * @notice Get all currently unfinalized rebalance amounts. Should be used to add virtual balance credits or
   * debits for the token and chain combinations. Will filter rebalances by the passed in account.
   * @dev Does not depend on this.rebalanceRoutes, only calls getPendingRebalances() for each configured adapter.
   * @dev If any adapter's pending-state read throws, the aggregate degrades to net debits only (and the failed
   * adapters are reported via getPendingReadFailures()) so that one adapter's upstream outage cannot fail the
   * aggregate read for every consumer. Net credits are dropped because adapters offset each other's entries: the
   * exchange adapters (Binance/Hyperliquid) emit a negative debit on the bridge destination chain to cancel the
   * CCTP/OFT adapters' credit for the same in-flight order, so an unpaired credit could overcount balances. Net
   * debits are kept because they only lower reported balances (a conservative undercount) and not every debit
   * offsets another adapter's credit: the exchange adapters also debit the withdrawal network once a venue
   * withdrawal has finalized there, offsetting real on-chain balance that is earmarked for the final destination
   * chain — dropping those debits would make earmarked funds look spendable.
   * @return Dictionary of chainId -> token -> amount where positive amounts present pending rebalance credits to that
   * chain while negative amounts represent debits that should be subtracted from that chain's current balance.
   */
  async getPendingRebalances(account: EvmAddress): Promise<{ [chainId: number]: { [token: string]: BigNumber } }> {
    const pendingRebalances: { [chainId: number]: { [token: string]: BigNumber } } = {};
    const failedAdapters: string[] = [];
    await forEachAsync(Object.entries(this.adapters), async ([adapterName, adapter]) => {
      let pending: { [chainId: number]: { [token: string]: BigNumber } };
      try {
        pending = await adapter.getPendingRebalances(account);
      } catch (err) {
        failedAdapters.push(adapterName);
        this.logger.warn({
          at: "BaseRebalancerClient.getPendingRebalances",
          message: `Failed to get pending rebalances from ${adapterName} adapter`,
          err: String(err),
        });
        return;
      }
      Object.entries(pending).forEach(([_chainId, tokenBalance]) => {
        const chainId = Number(_chainId);
        Object.entries(tokenBalance).forEach(([token, amount]) => {
          pendingRebalances[chainId] ??= {};
          pendingRebalances[chainId][token] = (pendingRebalances[chainId]?.[token] ?? bnZero).add(amount);
        });
      });
    });
    this.pendingReadFailures = failedAdapters;
    if (failedAdapters.length > 0) {
      // Filter net debits after aggregation so that entries which legitimately offset each other within a
      // (chainId, token) key (e.g. a bridge adapter's credit and an exchange adapter's debit for the same
      // in-flight order, both read successfully) net out instead of surfacing as a phantom debit.
      const netDebits: { [chainId: number]: { [token: string]: BigNumber } } = {};
      Object.entries(pendingRebalances).forEach(([_chainId, tokenBalance]) => {
        const chainId = Number(_chainId);
        Object.entries(tokenBalance).forEach(([token, amount]) => {
          if (amount.lt(bnZero)) {
            netDebits[chainId] ??= {};
            netDebits[chainId][token] = amount;
          }
        });
      });
      this.logger.warn({
        at: "BaseRebalancerClient.getPendingRebalances",
        message:
          "Returning only net pending-rebalance debits because some adapter reads failed;" +
          " in-flight rebalance credits are invisible to virtual balances until every adapter read succeeds",
        failedAdapters,
      });
      return netDebits;
    }
    return pendingRebalances;
  }

  /**
   * @notice Names of adapters whose reads failed during the most recent getPendingRebalances() call. Non-empty
   * means that call degraded to a net-debits-only aggregate, i.e. in-flight rebalance credits are currently
   * uncounted and derived balances undercount in-flight rebalances. Callers that move funds based on that
   * accounting (e.g. the rebalancer runtime) should fail closed and skip sending new rebalances.
   */
  getPendingReadFailures(): string[] {
    return [...this.pendingReadFailures];
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

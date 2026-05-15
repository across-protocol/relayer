// This is a very lightweight client that is easy to construct (only takes in a logger object) and is designed to
// be used by the InventoryClient to get the pending bridge state for CCTP and OFT adapters so as not to confuse
// InventoryClient rebalances with Rebalancer rebalances, for accounting purposes. This client adds middleware
// that makes reading the pending bridge state for CCTP and OFT adapters efficient by caching results.

import { EvmAddress, isDefined, winston } from "../../utils";
import {
  getPendingBridgeStatusSetKey,
  getRedisCacheForRebalancerStatusTracking,
  OFT_PENDING_BRIDGE_REDIS_PREFIX,
  CCTP_PENDING_BRIDGE_REDIS_PREFIX,
  redisGetOrderDetailsForAdapter,
  STATUS,
} from "../utils/utils";
import { OrderDetails } from "../utils/interfaces";

// Keep Redis reads cheap within a single accounting pass without masking cross-process updates for long.
const PENDING_BRIDGE_REDIS_READER_CACHE_TTL_MS = 5_000;

// The adapters supported by this lightweight reader.
export type PendingBridgeAdapterName = "oft" | "cctp";

// Normalized shape returned by the reader after decoding Redis payloads.
interface PendingBridgeRedisOrder extends OrderDetails {
  adapter: PendingBridgeAdapterName;
  cloid: string;
  txnRef: string;
}

interface PendingBridgeSnapshot {
  orders: PendingBridgeRedisOrder[];
  // Indexed by `sourceChain:destinationChain` so callers can cheaply ask for route-local ignore sets.
  txnRefsByRoute: Record<string, Set<string>>;
  loadedAtMs: number;
}

// Bridge adapters expose different identifiers to downstream consumers:
// - OFT already uses the transfer id we want to ignore.
// - CCTP stores a composite `cloid` whose suffix is the on-chain tx hash / reference used elsewhere.
// The reader normalizes both into a single `txnRef` field.
function getTxnRefFromCloid(adapter: PendingBridgeAdapterName, cloid: string): string {
  if (adapter === "oft") {
    return cloid;
  }

  const [, ...txnHashParts] = cloid.split("-");
  return txnHashParts.join("-");
}

// Reads the rebalancer's pending bridge bookkeeping from Redis. The point of this class is to be even more lightweight
// than the ReadOnlyRebalancerClient class so it can be used more easily in the src/adapters' code to help
// filter out CCTP/OFT bridges that were sent from the Rebalancer and can be ignored from the InventoryClient's
// accounting.
//
// Goal:
// Bridge adapters and higher-level clients need to recognize transfers that were initiated by the
// rebalancer itself so those transfers are not mistaken for "external" bridge activity and counted twice.
//
// Design notes:
// - This reader is intentionally read-only and easy to construct from anywhere.
// - It converts the raw Redis schema into both a flat order list and a route-local txnRef index.
// - It uses a very short in-memory TTL because callers often ask several related questions during one
//   accounting pass, but we still want cross-process Redis updates to become visible quickly.
export class CctpOftReadOnlyClient {
  supportedAdapterNames: PendingBridgeAdapterName[] = ["oft", "cctp"];
  // Cache one parsed snapshot per (adapter, account) so repeated route lookups don't re-scan Redis immediately.
  private snapshots: Record<string, PendingBridgeSnapshot> = {};
  // Reuse the same refresh when multiple callers ask for the same (adapter, account) concurrently.
  private snapshotPromises: Record<string, Promise<PendingBridgeSnapshot>> = {};

  constructor(private readonly logger?: winston.Logger) {}

  // Returns only the transaction references relevant to a single route. This is the hot path used by
  // bridge adapters when they need a fast "ignore list" for source->destination transfer detection.
  async getPendingBridgeTxnRefsForRoute(
    adapter: PendingBridgeAdapterName,
    sourceChain: number,
    destinationChain: number,
    account: EvmAddress
  ): Promise<Set<string>> {
    const { txnRefsByRoute } = await this._getPendingBridgeSnapshot(adapter, account);
    return new Set(txnRefsByRoute[this._getRouteKey(sourceChain, destinationChain)] ?? []);
  }

  private async _getPendingBridgeSnapshot(
    adapter: PendingBridgeAdapterName,
    account: EvmAddress
  ): Promise<PendingBridgeSnapshot> {
    const cacheSnapshotKey = `${adapter}:${account}`;
    const cachedSnapshot = this.snapshots[cacheSnapshotKey];
    if (
      isDefined(cachedSnapshot) &&
      Date.now() - cachedSnapshot.loadedAtMs < PENDING_BRIDGE_REDIS_READER_CACHE_TTL_MS
    ) {
      return cachedSnapshot;
    }

    // Avoid duplicate SMEMBERS + GET fanout while a refresh is already in flight for this adapter.
    this.snapshotPromises[cacheSnapshotKey] ??= this._loadPendingBridgeSnapshot(adapter, account);
    try {
      const snapshot = await this.snapshotPromises[cacheSnapshotKey];
      this.snapshots[cacheSnapshotKey] = snapshot;
      return snapshot;
    } finally {
      delete this.snapshotPromises[cacheSnapshotKey];
    }
  }

  private async _loadPendingBridgeSnapshot(
    adapter: PendingBridgeAdapterName,
    account: EvmAddress
  ): Promise<PendingBridgeSnapshot> {
    const redisCache = await getRedisCacheForRebalancerStatusTracking(this.logger);
    if (!isDefined(redisCache)) {
      // Status tracking is optional. When Redis is unavailable or disabled, behave as though there are
      // no pending bridge orders so callers can continue operating without special-case handling.
      return { orders: [], txnRefsByRoute: {}, loadedAtMs: Date.now() };
    }

    // The set is the source of truth for "currently pending" orders. Each member points to a JSON blob
    // stored under its own key.
    const cloids = await redisCache.sMembers(
      getPendingBridgeStatusSetKey(
        this._getPendingBridgeRedisPrefix(adapter),
        STATUS.PENDING_BRIDGE_PRE_DEPOSIT,
        account.toNative()
      )
    );
    const orders = await Promise.all(
      cloids.map(async (cloid) => {
        const order = await redisGetOrderDetailsForAdapter(
          redisCache,
          this._getPendingBridgeRedisPrefix(adapter),
          cloid,
          account
        );
        if (!order) {
          return undefined;
        }
        return {
          adapter,
          cloid,
          txnRef: getTxnRefFromCloid(adapter, cloid),
          ...order,
        };
      })
    );

    const filteredOrders = orders.filter(isDefined);
    // Pre-index txn refs by route because bridge adapters only need route-local ignore sets.
    const txnRefsByRoute = filteredOrders.reduce<Record<string, Set<string>>>((acc, order) => {
      const routeKey = this._getRouteKey(order.sourceChain, order.destinationChain);
      acc[routeKey] ??= new Set<string>();
      acc[routeKey].add(order.txnRef);
      return acc;
    }, {});

    return { orders: filteredOrders, txnRefsByRoute, loadedAtMs: Date.now() };
  }

  private _getRouteKey(sourceChain: number, destinationChain: number): string {
    // Route keys stay local to this module, so a simple stable string is enough.
    return `${sourceChain}:${destinationChain}`;
  }

  private _getPendingBridgeRedisPrefix(adapter: PendingBridgeAdapterName): string {
    return adapter === "oft" ? OFT_PENDING_BRIDGE_REDIS_PREFIX : CCTP_PENDING_BRIDGE_REDIS_PREFIX;
  }
}

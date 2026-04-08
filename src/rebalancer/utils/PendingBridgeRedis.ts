import { RedisCache } from "../../caching/RedisCache";
import { BigNumber, EvmAddress, getRedisCache, isDefined, winston } from "../../utils";

// Redis keys are grouped by adapter so OFT and CCTP orders can be tracked independently while
// still sharing the same reader implementation.
export const OFT_PENDING_BRIDGE_REDIS_PREFIX = "oft-bridge:";
export const CCTP_PENDING_BRIDGE_REDIS_PREFIX = "cctp-bridge:";

// For each adapter we maintain:
// 1. A set containing all currently pending order ids (`cloid`s).
// 2. One JSON payload per `cloid` containing the order details.
const PENDING_ORDER_REDIS_SUFFIX = "pending-order";
const PENDING_BRIDGE_PRE_DEPOSIT_REDIS_SUFFIX = "pending-bridge-pre-deposit";
// Keep Redis reads cheap within a single accounting pass without masking cross-process updates for long.
const PENDING_BRIDGE_REDIS_READER_CACHE_TTL_MS = 5_000;

export type PendingBridgeAdapterName = "oft" | "cctp";

// Normalized shape returned by the reader after decoding Redis payloads.
interface PendingBridgeRedisOrder {
  adapter: PendingBridgeAdapterName;
  cloid: string;
  txnRef: string;
  sourceToken: string;
  destinationToken: string;
  sourceChain: number;
  destinationChain: number;
  amountToTransfer: BigNumber;
}

interface PendingBridgeRedisOrderPayload {
  sourceToken: string;
  destinationToken: string;
  sourceChain: number;
  destinationChain: number;
  amountToTransfer: string;
}

interface PendingBridgeSnapshot {
  orders: PendingBridgeRedisOrder[];
  // Indexed by `sourceChain:destinationChain` so callers can cheaply ask for route-local ignore sets.
  txnRefsByRoute: Record<string, Set<string>>;
  loadedAtMs: number;
}

// Optional namespace that lets different rebalancer deployments keep their status-tracking data isolated
// even if they share the same Redis instance.
export function getRebalancerStatusTrackingNamespace(): string | undefined {
  return process.env.REBALANCER_STATUS_TRACKING_NAMESPACE
    ? String(process.env.REBALANCER_STATUS_TRACKING_NAMESPACE)
    : undefined;
}

function getPendingBridgeRedisPrefix(adapter: PendingBridgeAdapterName): string {
  return adapter === "oft" ? OFT_PENDING_BRIDGE_REDIS_PREFIX : CCTP_PENDING_BRIDGE_REDIS_PREFIX;
}

function getPendingBridgeStatusSetKey(adapter: PendingBridgeAdapterName, account: EvmAddress): string {
  return `${getPendingBridgeRedisPrefix(adapter)}${PENDING_BRIDGE_PRE_DEPOSIT_REDIS_SUFFIX}:${account.toNative().toLowerCase()}`;
}

function getPendingBridgeOrderKey(adapter: PendingBridgeAdapterName, cloid: string): string {
  return `${getPendingBridgeRedisPrefix(adapter)}${PENDING_ORDER_REDIS_SUFFIX}:${cloid}`;
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

// Reads the rebalancer's pending bridge bookkeeping from Redis.
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
export class PendingBridgeRedisReader {
  private redisCachePromise?: Promise<RedisCache | undefined>;
  // Cache one parsed snapshot per adapter so repeated route lookups don't re-scan Redis immediately.
  private snapshots: Partial<Record<PendingBridgeAdapterName, PendingBridgeSnapshot>> = {};
  // Reuse the same refresh when multiple callers ask for the same adapter concurrently.
  private snapshotPromises: Partial<Record<PendingBridgeAdapterName, Promise<PendingBridgeSnapshot>>> = {};

  constructor(private readonly logger?: winston.Logger) {}

  // Returns only the transaction references relevant to a single route. This is the hot path used by
  // bridge adapters when they need a fast "ignore list" for source->destination transfer detection.
  async getPendingBridgeTxnRefsForRoute(
    adapter: PendingBridgeAdapterName,
    sourceChain: number,
    destinationChain: number,
    account: EvmAddress
  ): Promise<Set<string>> {
    const { txnRefsByRoute } = await this.getPendingBridgeSnapshot(adapter, account);
    return new Set(txnRefsByRoute[this.getRouteKey(sourceChain, destinationChain)] ?? []);
  }

  private async getPendingBridgeSnapshot(
    adapter: PendingBridgeAdapterName,
    account: EvmAddress
  ): Promise<PendingBridgeSnapshot> {
    const cacheSnapshotKey = `${adapter}:${account.toNative()}`;
    const cachedSnapshot = this.snapshots[cacheSnapshotKey];
    if (
      isDefined(cachedSnapshot) &&
      Date.now() - cachedSnapshot.loadedAtMs < PENDING_BRIDGE_REDIS_READER_CACHE_TTL_MS
    ) {
      return cachedSnapshot;
    }

    // Avoid duplicate SMEMBERS + GET fanout while a refresh is already in flight for this adapter.
    this.snapshotPromises[cacheSnapshotKey] ??= this.loadPendingBridgeSnapshot(adapter, account);
    try {
      const snapshot = await this.snapshotPromises[cacheSnapshotKey];
      this.snapshots[cacheSnapshotKey] = snapshot;
      return snapshot;
    } finally {
      this.snapshotPromises[cacheSnapshotKey] = undefined;
    }
  }

  private async loadPendingBridgeSnapshot(
    adapter: PendingBridgeAdapterName,
    account: EvmAddress
  ): Promise<PendingBridgeSnapshot> {
    const redisCache = await this.getRedisCache();
    if (!isDefined(redisCache)) {
      // Status tracking is optional. When Redis is unavailable or disabled, behave as though there are
      // no pending bridge orders so callers can continue operating without special-case handling.
      return { orders: [], txnRefsByRoute: {}, loadedAtMs: Date.now() };
    }

    // The set is the source of truth for "currently pending" orders. Each member points to a JSON blob
    // stored under its own key.
    const cloids = await redisCache.sMembers(getPendingBridgeStatusSetKey(adapter, account));
    const orders = await Promise.all(
      cloids.map(async (cloid) => {
        const rawOrder = await redisCache.get<string>(getPendingBridgeOrderKey(adapter, cloid));
        if (!rawOrder) {
          // Tolerate races where the set member still exists but the payload has already been removed.
          // This client is not responsible for cleaning up the cache, for simplicity reasons, and instead leaves
          // the rebalancer adapters to remove these stale set members.
          return undefined;
        }

        const order = JSON.parse(rawOrder) as PendingBridgeRedisOrderPayload;
        return {
          adapter,
          cloid,
          txnRef: getTxnRefFromCloid(adapter, cloid),
          ...order,
          amountToTransfer: BigNumber.from(order.amountToTransfer),
        } satisfies PendingBridgeRedisOrder;
      })
    );

    const filteredOrders = orders.filter(isDefined);
    // Pre-index txn refs by route because bridge adapters only need route-local ignore sets.
    const txnRefsByRoute = filteredOrders.reduce<Record<string, Set<string>>>((acc, order) => {
      const routeKey = this.getRouteKey(order.sourceChain, order.destinationChain);
      acc[routeKey] ??= new Set<string>();
      acc[routeKey].add(order.txnRef);
      return acc;
    }, {});

    return { orders: filteredOrders, txnRefsByRoute, loadedAtMs: Date.now() };
  }

  private getRedisCache(): Promise<RedisCache | undefined> {
    // Reuse the same Redis client promise across all reads from this reader instance.
    this.redisCachePromise ??= getRedisCache(this.logger, undefined, getRebalancerStatusTrackingNamespace()) as Promise<
      RedisCache | undefined
    >;
    return this.redisCachePromise;
  }

  private getRouteKey(sourceChain: number, destinationChain: number): string {
    // Route keys stay local to this module, so a simple stable string is enough.
    return `${sourceChain}:${destinationChain}`;
  }
}

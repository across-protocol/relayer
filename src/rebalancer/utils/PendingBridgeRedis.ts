import { RedisCache } from "../../caching/RedisCache";
import { BigNumber, getRedisCache, isDefined, winston } from "../../utils";

export const OFT_PENDING_BRIDGE_REDIS_PREFIX = "oft-bridge:";
export const CCTP_PENDING_BRIDGE_REDIS_PREFIX = "cctp-bridge:";

const PENDING_ORDER_REDIS_SUFFIX = "pending-order";
const PENDING_BRIDGE_PRE_DEPOSIT_REDIS_SUFFIX = "pending-bridge-pre-deposit";
// Keep Redis reads cheap within a single accounting pass without masking cross-process updates for long.
const PENDING_BRIDGE_REDIS_READER_CACHE_TTL_MS = 5_000;

export type PendingBridgeAdapterName = "oft" | "cctp";

export interface PendingBridgeRedisOrder {
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
  txnRefsByRoute: Record<string, Set<string>>;
  loadedAtMs: number;
}

export function getRebalancerStatusTrackingNamespace(): string | undefined {
  return process.env.REBALANCER_STATUS_TRACKING_NAMESPACE
    ? String(process.env.REBALANCER_STATUS_TRACKING_NAMESPACE)
    : undefined;
}

function getPendingBridgeRedisPrefix(adapter: PendingBridgeAdapterName): string {
  return adapter === "oft" ? OFT_PENDING_BRIDGE_REDIS_PREFIX : CCTP_PENDING_BRIDGE_REDIS_PREFIX;
}

function getPendingBridgeStatusSetKey(adapter: PendingBridgeAdapterName): string {
  return `${getPendingBridgeRedisPrefix(adapter)}${PENDING_BRIDGE_PRE_DEPOSIT_REDIS_SUFFIX}`;
}

function getPendingBridgeOrderKey(adapter: PendingBridgeAdapterName, cloid: string): string {
  return `${getPendingBridgeRedisPrefix(adapter)}${PENDING_ORDER_REDIS_SUFFIX}:${cloid}`;
}

function getTxnRefFromCloid(adapter: PendingBridgeAdapterName, cloid: string): string {
  if (adapter === "oft") {
    return cloid;
  }

  const [, ...txnHashParts] = cloid.split("-");
  return txnHashParts.join("-");
}

// @dev This class is used to read pending bridge orders from Redis that were initiated
// by the rebalancer. It's designed to be easy to construct and to be used by external clients, like
// the AdapterManager who might want to filter for orders that would look like ordinary L1/L2->L2/L2 cross-chain
// transfers but were initiated by the rebalancer and therefore should not be double counted.
export class PendingBridgeRedisReader {
  private redisCachePromise?: Promise<RedisCache | undefined>;
  // Cache one parsed snapshot per adapter so repeated route lookups don't re-scan Redis immediately.
  private snapshots: Partial<Record<PendingBridgeAdapterName, PendingBridgeSnapshot>> = {};
  // Reuse the same refresh when multiple callers ask for the same adapter concurrently.
  private snapshotPromises: Partial<Record<PendingBridgeAdapterName, Promise<PendingBridgeSnapshot>>> = {};

  constructor(private readonly logger?: winston.Logger) {}

  async getPendingBridgeOrders(adapter: PendingBridgeAdapterName): Promise<PendingBridgeRedisOrder[]> {
    return (await this.getPendingBridgeSnapshot(adapter)).orders;
  }

  async getPendingBridgeTxnRefsForRoute(
    adapter: PendingBridgeAdapterName,
    sourceChain: number,
    destinationChain: number
  ): Promise<Set<string>> {
    const { txnRefsByRoute } = await this.getPendingBridgeSnapshot(adapter);
    return new Set(txnRefsByRoute[this.getRouteKey(sourceChain, destinationChain)] ?? []);
  }

  private async getPendingBridgeSnapshot(adapter: PendingBridgeAdapterName): Promise<PendingBridgeSnapshot> {
    const cachedSnapshot = this.snapshots[adapter];
    if (
      isDefined(cachedSnapshot) &&
      Date.now() - cachedSnapshot.loadedAtMs < PENDING_BRIDGE_REDIS_READER_CACHE_TTL_MS
    ) {
      return cachedSnapshot;
    }

    // Avoid duplicate SMEMBERS + GET fanout while a refresh is already in flight for this adapter.
    this.snapshotPromises[adapter] ??= this.loadPendingBridgeSnapshot(adapter);
    try {
      const snapshot = await this.snapshotPromises[adapter];
      this.snapshots[adapter] = snapshot;
      return snapshot;
    } finally {
      this.snapshotPromises[adapter] = undefined;
    }
  }

  private async loadPendingBridgeSnapshot(adapter: PendingBridgeAdapterName): Promise<PendingBridgeSnapshot> {
    const redisCache = await this.getRedisCache();
    if (!isDefined(redisCache)) {
      return { orders: [], txnRefsByRoute: {}, loadedAtMs: Date.now() };
    }

    const cloids = await redisCache.sMembers(getPendingBridgeStatusSetKey(adapter));
    const orders = await Promise.all(
      cloids.map(async (cloid) => {
        const rawOrder = await redisCache.get<string>(getPendingBridgeOrderKey(adapter, cloid));
        if (!rawOrder) {
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
    this.redisCachePromise ??= getRedisCache(this.logger, undefined, getRebalancerStatusTrackingNamespace()) as Promise<
      RedisCache | undefined
    >;
    return this.redisCachePromise;
  }

  private getRouteKey(sourceChain: number, destinationChain: number): string {
    return `${sourceChain}:${destinationChain}`;
  }
}

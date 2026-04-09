import { EvmAddress, isDefined, winston } from "../../utils";
import {
  getPendingBridgeStatusSetKey,
  getRedisCacheForRebalancerStatusTracking,
  OFT_PENDING_BRIDGE_REDIS_PREFIX,
  CCTP_PENDING_BRIDGE_REDIS_PREFIX,
  redisGetOrderDetailsForAdapter,
  STATUS,
} from "./utils";
import { OrderDetails } from "./interfaces";

// Keep Redis reads cheap within a single accounting pass without masking cross-process updates for long.
const PENDING_BRIDGE_REDIS_READER_CACHE_TTL_MS = 5_000;

export type PendingBridgeAdapterName = "oft" | "cctp";

interface PendingBridgeRedisOrder extends OrderDetails {
  adapter: PendingBridgeAdapterName;
  cloid: string;
  txnRef: string;
}

interface PendingBridgeSnapshot {
  orders: PendingBridgeRedisOrder[];
  txnRefsByRoute: Record<string, Set<string>>;
  loadedAtMs: number;
}

function getTxnRefFromCloid(adapter: PendingBridgeAdapterName, cloid: string): string {
  if (adapter === "oft") {
    return cloid;
  }

  const [, ...txnHashParts] = cloid.split("-");
  return txnHashParts.join("-");
}

export class PendingBridgeRedisReader {
  private snapshots: Partial<Record<PendingBridgeAdapterName, PendingBridgeSnapshot>> = {};
  private snapshotPromises: Partial<Record<PendingBridgeAdapterName, Promise<PendingBridgeSnapshot>>> = {};

  constructor(private readonly logger?: winston.Logger) {}

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
    const cacheSnapshotKey = `${adapter}:${account}`;
    const cachedSnapshot = this.snapshots[cacheSnapshotKey];
    if (
      isDefined(cachedSnapshot) &&
      Date.now() - cachedSnapshot.loadedAtMs < PENDING_BRIDGE_REDIS_READER_CACHE_TTL_MS
    ) {
      return cachedSnapshot;
    }

    this.snapshotPromises[cacheSnapshotKey] ??= this.loadPendingBridgeSnapshot(adapter, account);
    try {
      const snapshot = await this.snapshotPromises[cacheSnapshotKey];
      this.snapshots[cacheSnapshotKey] = snapshot;
      return snapshot;
    } finally {
      delete this.snapshotPromises[cacheSnapshotKey];
    }
  }

  private async loadPendingBridgeSnapshot(
    adapter: PendingBridgeAdapterName,
    account: EvmAddress
  ): Promise<PendingBridgeSnapshot> {
    const redisCache = await getRedisCacheForRebalancerStatusTracking(this.logger);
    if (!isDefined(redisCache)) {
      return { orders: [], txnRefsByRoute: {}, loadedAtMs: Date.now() };
    }

    const cloids = await redisCache.sMembers(
      getPendingBridgeStatusSetKey(
        this.getPendingBridgeRedisPrefix(adapter),
        STATUS.PENDING_BRIDGE_PRE_DEPOSIT,
        account.toNative()
      )
    );
    const orders = await Promise.all(
      cloids.map(async (cloid) => {
        const order = await redisGetOrderDetailsForAdapter(
          redisCache,
          this.getPendingBridgeRedisPrefix(adapter),
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
    const txnRefsByRoute = filteredOrders.reduce<Record<string, Set<string>>>((acc, order) => {
      const routeKey = this.getRouteKey(order.sourceChain, order.destinationChain);
      acc[routeKey] ??= new Set<string>();
      acc[routeKey].add(order.txnRef);
      return acc;
    }, {});

    return { orders: filteredOrders, txnRefsByRoute, loadedAtMs: Date.now() };
  }

  private getRouteKey(sourceChain: number, destinationChain: number): string {
    return `${sourceChain}:${destinationChain}`;
  }

  private getPendingBridgeRedisPrefix(adapter: PendingBridgeAdapterName): string {
    return adapter === "oft" ? OFT_PENDING_BRIDGE_REDIS_PREFIX : CCTP_PENDING_BRIDGE_REDIS_PREFIX;
  }
}

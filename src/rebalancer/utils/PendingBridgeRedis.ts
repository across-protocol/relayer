import { RedisCache } from "../../caching/RedisCache";
import { BigNumber, getRedisCache, isDefined, winston } from "../../utils";

export const OFT_PENDING_BRIDGE_REDIS_PREFIX = "oft-bridge:";
export const CCTP_PENDING_BRIDGE_REDIS_PREFIX = "cctp-bridge:";

const PENDING_ORDER_REDIS_SUFFIX = "pending-order";
const PENDING_BRIDGE_PRE_DEPOSIT_REDIS_SUFFIX = "pending-bridge-pre-deposit";

export type PendingBridgeAdapterName = "oft" | "cctp";

export interface PendingBridgeRedisOrder {
  adapter: PendingBridgeAdapterName;
  cloid: string;
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

export class PendingBridgeRedisReader {
  private redisCachePromise?: Promise<RedisCache | undefined>;

  constructor(private readonly logger?: winston.Logger) {}

  async getPendingBridgeOrders(adapter: PendingBridgeAdapterName): Promise<PendingBridgeRedisOrder[]> {
    const redisCache = await this.getRedisCache();
    if (!isDefined(redisCache)) {
      return [];
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
          ...order,
          amountToTransfer: BigNumber.from(order.amountToTransfer),
        } satisfies PendingBridgeRedisOrder;
      })
    );

    return orders.filter(isDefined);
  }

  async getPendingBridgeAmountsForRoute(
    adapter: PendingBridgeAdapterName,
    sourceChain: number,
    destinationChain: number,
    tokenSymbol: string
  ): Promise<BigNumber[]> {
    const orders = await this.getPendingBridgeOrders(adapter);
    return orders
      .filter(
        (order) =>
          order.sourceChain === sourceChain &&
          order.destinationChain === destinationChain &&
          (order.sourceToken === tokenSymbol || order.destinationToken === tokenSymbol)
      )
      .map((order) => order.amountToTransfer);
  }

  private getRedisCache(): Promise<RedisCache | undefined> {
    this.redisCachePromise ??= getRedisCache(this.logger, undefined, getRebalancerStatusTrackingNamespace()) as Promise<
      RedisCache | undefined
    >;
    return this.redisCachePromise;
  }
}

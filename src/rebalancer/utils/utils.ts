import { RedisCache } from "../../caching/RedisCache";
import {
  BigNumber,
  ConvertDecimals,
  EvmAddress,
  ethers,
  getRedisCache,
  getTokenInfoFromSymbol,
  winston,
} from "../../utils";
import { ExcessOrDeficit, OrderDetails, RedisOrderDetailsPayload } from "./interfaces";

// Optional namespace that lets different rebalancer deployments keep their status-tracking data isolated
// even if they share the same Redis instance.
function getRebalancerStatusTrackingNamespace(): string | undefined {
  return process.env.REBALANCER_STATUS_TRACKING_NAMESPACE
    ? String(process.env.REBALANCER_STATUS_TRACKING_NAMESPACE)
    : undefined;
}

export async function getRedisCacheForRebalancerStatusTracking(
  logger: winston.Logger
): Promise<RedisCache | undefined> {
  return (await getRedisCache(logger, undefined, getRebalancerStatusTrackingNamespace())) as RedisCache;
}

function compareNormalizedAmounts(
  excessA: ExcessOrDeficit,
  excessB: ExcessOrDeficit,
  tokenPricesUsd?: Map<string, BigNumber>
): number {
  const { token: tokenA, amount: amountA, chainId: chainIdA } = excessA;
  const { token: tokenB, amount: amountB, chainId: chainIdB } = excessB;
  const tokenADecimals = getTokenInfoFromSymbol(tokenA, Number(chainIdA)).decimals;
  const tokenBDecimals = getTokenInfoFromSymbol(tokenB, Number(chainIdB)).decimals;
  const converter = ConvertDecimals(tokenADecimals, tokenBDecimals);
  const normalizedAmountA =
    tokenPricesUsd && tokenPricesUsd.has(tokenA) ? amountA.mul(tokenPricesUsd.get(tokenA)) : amountA;
  const normalizedAmountB =
    tokenPricesUsd && tokenPricesUsd.has(tokenB) ? amountB.mul(tokenPricesUsd.get(tokenB)) : amountB;
  if (converter(normalizedAmountA).eq(normalizedAmountB)) {
    return 0;
  }
  return converter(normalizedAmountA).gt(normalizedAmountB) ? -1 : 1;
}
// Excesses are always sorted in priority from lowest to highest and then by amount from largest to smallest.
export function sortExcessFunction(
  excessA: ExcessOrDeficit,
  excessB: ExcessOrDeficit,
  tokenPricesUsd?: Map<string, BigNumber>
): number {
  const { priorityTier: priorityTierA } = excessA;
  const { priorityTier: priorityTierB } = excessB;
  if (priorityTierA !== priorityTierB) {
    return priorityTierA - priorityTierB;
  }
  return compareNormalizedAmounts(excessA, excessB, tokenPricesUsd);
}
// Deficits are always sorted in priority from highest to lowest and then by amount from largest to smallest.
export function sortDeficitFunction(
  deficitA: ExcessOrDeficit,
  deficitB: ExcessOrDeficit,
  tokenPricesUsd?: Map<string, BigNumber>
): number {
  const { priorityTier: priorityTierA } = deficitA;
  const { priorityTier: priorityTierB } = deficitB;
  if (priorityTierA !== priorityTierB) {
    return priorityTierB - priorityTierA;
  }
  return compareNormalizedAmounts(deficitA, deficitB, tokenPricesUsd);
}

export function getCloidForAccount(account: string): string {
  // We want cloids to stay unique even if we rotate the Redis namespace. Combine the current unix timestamp
  // with the relayer account so different relayer instances cannot collide even when they create orders in
  // the same second. This still assumes one relayer instance won't create multiple orders in the same ms.
  const unixTimestamp = Date.now();
  const cloidSeed = ethers.utils.solidityPack(["uint256", "address"], [unixTimestamp, account]);
  // @dev Hyperliquid requires a 128 bit/16 byte string for a cloid, other adapters don't seem to have any requirements.
  return ethers.utils.hexDataSlice(ethers.utils.keccak256(cloidSeed), 0, 16);
}
export enum STATUS {
  PENDING_BRIDGE_PRE_DEPOSIT,
  PENDING_DEPOSIT,
  PENDING_SWAP,
  PENDING_WITHDRAWAL,
}

export function getPendingBridgeStatusSetKey(redisPrefix: string, status: STATUS, account: string): string {
  let orderStatusKey: string;
  switch (status) {
    case STATUS.PENDING_DEPOSIT:
      orderStatusKey = redisPrefix + "pending-deposit";
      break;
    case STATUS.PENDING_SWAP:
      orderStatusKey = redisPrefix + "pending-swap";
      break;
    case STATUS.PENDING_WITHDRAWAL:
      orderStatusKey = redisPrefix + "pending-withdrawal";
      break;
    case STATUS.PENDING_BRIDGE_PRE_DEPOSIT:
      orderStatusKey = redisPrefix + "pending-bridge-pre-deposit";
      break;
    default:
      throw new Error(`Invalid status: ${status}`);
  }
  return `${orderStatusKey}:${account.toLowerCase()}`;
}

export function getPendingBridgeOrderKey(redisPrefix: string, cloid: string, account: string): string {
  return `${redisPrefix}pending-order:${cloid}:${account.toLowerCase()}`;
}

export async function redisGetOrderDetailsForAdapter(
  redisCache: RedisCache,
  adapterRedisPrefix: string,
  cloid: string,
  account: EvmAddress
): Promise<OrderDetails> {
  const orderDetailsKey = getPendingBridgeOrderKey(adapterRedisPrefix, cloid, account.toNative());
  const orderDetails = await redisCache.get<string>(orderDetailsKey);
  if (!orderDetails) {
    return undefined;
  }
  const rebalanceRoute = JSON.parse(orderDetails) as RedisOrderDetailsPayload;
  return {
    ...rebalanceRoute,
    amountToTransfer: BigNumber.from(rebalanceRoute.amountToTransfer),
  };
}

export const CCTP_PENDING_BRIDGE_REDIS_PREFIX = "cctp-bridge:";
export const OFT_PENDING_BRIDGE_REDIS_PREFIX = "oft-bridge:";

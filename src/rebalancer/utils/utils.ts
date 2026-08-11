import {
  BigNumber,
  ConvertDecimals,
  EvmAddress,
  ethers,
  getTokenInfoFromSymbol,
  isDefined,
  toBNWei,
  winston,
} from "../../utils";
import { getRedisCache, RedisCache } from "../../cache/Redis";
import { ExcessOrDeficit, OrderDetails, RedisOrderDetailsPayload } from "./interfaces";

const REBALANCER_INITIATION_LOCK_TTL_MS = 30 * 60 * 1000;

export function getRebalancerInitiationLockKey(account: string): string {
  return `rebalancer-initiation-lock:${account.toLowerCase()}`;
}

/**
 * Serialize an entire plan-and-initiate rebalancer run per account: balance snapshots and the initiations they
 * produce happen while the lock is held, so an overlapping run can never initiate from a snapshot that predates
 * another run's orders. When the lock is already held the run is skipped (runs are frequent); a crashed holder's
 * lock expires via TTL. Without a status-tracking Redis, runs proceed unserialized.
 */
export async function withRebalancerInitiationLock<T>(
  logger: winston.Logger,
  account: string,
  fn: () => Promise<T>,
  redisCache?: RedisCache
): Promise<T | undefined> {
  redisCache ??= await getRedisCacheForRebalancerStatusTracking(logger);
  if (!isDefined(redisCache)) {
    logger.debug({
      at: "withRebalancerInitiationLock",
      message: "No rebalancer status-tracking Redis configured; running without the initiation lock",
    });
    return fn();
  }
  const key = getRebalancerInitiationLockKey(account);
  const token = getCloidForAccount(account);
  if (!(await redisCache.acquireLock(key, token, REBALANCER_INITIATION_LOCK_TTL_MS))) {
    logger.warn({
      at: "withRebalancerInitiationLock",
      message: "Another rebalancer run holds the initiation lock; skipping this run",
      account,
    });
    return undefined;
  }
  try {
    return await fn();
  } finally {
    await redisCache.releaseLock(key, token).catch((error) =>
      logger.warn({
        at: "withRebalancerInitiationLock",
        message: "Failed to release the rebalancer initiation lock; waiting for its TTL",
        error,
      })
    );
  }
}

// The operator's maximum acceptable venue cost, in percentage points scaled to 18 decimals (default 2.5%).
export function getMaxFeePct(): BigNumber {
  return toBNWei(process.env.MAX_FEE_PCT ?? "2.5");
}

// The maximum acceptable venue cost for a rebalance of `amount`, from getMaxFeePct().
export function getMaxFee(amount: BigNumber): BigNumber {
  return amount.mul(getMaxFeePct()).div(toBNWei(100));
}

// @todo Default low for now, eventually change this to a very high default value.
export function getMaxPendingOrders(
  config: { maxPendingOrders: { [adapter: string]: number | undefined } },
  adapterName: string
): number {
  return config.maxPendingOrders[adapterName] ?? 2;
}

// Optional namespace that lets different rebalancer deployments keep their status-tracking data isolated
// even if they share the same Redis instance.
function getRebalancerStatusTrackingNamespace(): string | undefined {
  return process.env.REBALANCER_STATUS_TRACKING_NAMESPACE
    ? String(process.env.REBALANCER_STATUS_TRACKING_NAMESPACE)
    : undefined;
}

export async function getRedisCacheForRebalancerStatusTracking(
  logger?: winston.Logger
): Promise<RedisCache | undefined> {
  return await getRedisCache(logger, undefined, getRebalancerStatusTrackingNamespace());
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
  const priceA = tokenPricesUsd?.get(tokenA);
  const priceB = tokenPricesUsd?.get(tokenB);
  const normalizedAmountA = isDefined(priceA) ? amountA.mul(priceA) : amountA;
  const normalizedAmountB = isDefined(priceB) ? amountB.mul(priceB) : amountB;
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
  // A direct Binance deposit whose order was persisted before the deposit transaction was submitted. Promoted to
  // PENDING_DEPOSIT once the deposit transaction hash is confirmed on-chain (or immediately after a clean submission).
  PENDING_DEPOSIT_SUBMISSION,
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
    case STATUS.PENDING_DEPOSIT_SUBMISSION:
      orderStatusKey = redisPrefix + "pending-deposit-submission";
      break;
    default:
      throw new Error(`Invalid status: ${status}`);
  }
  return `${orderStatusKey}:${account.toLowerCase()}`;
}

export function getPendingBridgeOrderKey(redisPrefix: string, cloid: string, account: string): string {
  return `${redisPrefix}pending-order:${cloid}:${account.toLowerCase()}`;
}

// Maps an order's cloid to the on-chain transaction that funded its venue deposit, so lifecycle transitions
// (e.g. pruning an expired order) can locate and untag the deposit.
export function getPendingBridgeDepositTxnKey(redisPrefix: string, cloid: string, account: string): string {
  return `${redisPrefix}deposit-txn:${cloid}:${account.toLowerCase()}`;
}

// Marks an order whose deposit submission may have broadcast without its outcome being recorded. While present,
// lifecycle passes resolve the order from the on-chain receipt instead of progressing it.
export function getPendingBridgeDepositRecoveryKey(redisPrefix: string, cloid: string, account: string): string {
  return `${redisPrefix}deposit-recovery:${cloid}:${account.toLowerCase()}`;
}

export async function redisGetOrderDetailsForAdapter(
  redisCache: RedisCache,
  adapterRedisPrefix: string,
  cloid: string,
  account: EvmAddress
): Promise<OrderDetails | undefined> {
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

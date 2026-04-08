import { ConvertDecimals, getTokenInfoFromSymbol } from "../../utils";
import { ExcessOrDeficit } from "./interfaces";

// Excesses are always sorted in priority from lowest to highest and then by amount from largest to smallest.
export function sortExcessFunction(excessA: ExcessOrDeficit, excessB: ExcessOrDeficit): number {
  const { token: tokenA, amount: amountA, priorityTier: priorityTierA, chainId: chainIdA } = excessA;
  const { token: tokenB, amount: amountB, priorityTier: priorityTierB, chainId: chainIdB } = excessB;
  if (priorityTierA !== priorityTierB) {
    return priorityTierA - priorityTierB;
  }
  const tokenADecimals = getTokenInfoFromSymbol(tokenA, Number(chainIdA)).decimals;
  const tokenBDecimals = getTokenInfoFromSymbol(tokenB, Number(chainIdB)).decimals;
  const converter = ConvertDecimals(tokenADecimals, tokenBDecimals);
  if (converter(amountA).eq(amountB)) {
    return 0;
  }
  return converter(amountA).gt(amountB) ? -1 : 1;
}
// Deficits are always sorted in priority from highest to lowest and then by amount from largest to smallest.
export function sortDeficitFunction(deficitA: ExcessOrDeficit, deficitB: ExcessOrDeficit): number {
  const { token: tokenA, amount: amountA, priorityTier: priorityTierA, chainId: chainIdA } = deficitA;
  const { token: tokenB, amount: amountB, priorityTier: priorityTierB, chainId: chainIdB } = deficitB;
  if (priorityTierA !== priorityTierB) {
    return priorityTierB - priorityTierA;
  }
  const tokenADecimals = getTokenInfoFromSymbol(tokenA, Number(chainIdA)).decimals;
  const tokenBDecimals = getTokenInfoFromSymbol(tokenB, Number(chainIdB)).decimals;
  const converter = ConvertDecimals(tokenADecimals, tokenBDecimals);
  if (converter(amountA).eq(amountB)) {
    return 0;
  }
  return converter(amountA).gt(amountB) ? -1 : 1;
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

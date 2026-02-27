import { ConvertDecimals, getTokenInfoFromSymbol } from "../../utils";
import { ExcessOrDeficit } from "./interfaces";

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

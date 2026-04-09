import { ConvertDecimals, getTokenInfoFromSymbol, ethers } from "../../utils";
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

export function getCloidForAccount(account: string): string {
  // We want cloids to stay unique even if we rotate the Redis namespace. Combine the current unix timestamp
  // with the relayer account so different relayer instances cannot collide even when they create orders in
  // the same second. This still assumes one relayer instance won't create multiple orders in the same second.
  const unixTimestamp = Date.now();
  const cloidSeed = ethers.utils.solidityPack(["uint256", "address"], [unixTimestamp, account]);
  return ethers.utils.hexDataSlice(ethers.utils.keccak256(cloidSeed), 0, 16);
}

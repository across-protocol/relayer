import { TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { constants, utils } from "@across-protocol/sdk";
import { CONTRACT_ADDRESSES } from "../common";
import { BigNumberish } from "./BNUtils";
import { formatUnits } from "./SDKUtils";

const { ZERO_ADDRESS } = constants;

export const { fetchTokenInfo, getL2TokenAddresses } = utils;

export function getNativeTokenAddressForChain(chainId: number): string {
  return CONTRACT_ADDRESSES[chainId]?.eth?.address ?? ZERO_ADDRESS;
}

/**
 * Format the given amount of tokens to the correct number of decimals for the given token symbol.
 * @param symbol The token symbol to format the amount for.
 * @param amount The amount to format.
 * @returns The formatted amount as a decimal-inclusive string.
 */
export function formatUnitsForToken(symbol: string, amount: BigNumberish): string {
  const decimals = (TOKEN_SYMBOLS_MAP[symbol]?.decimals as number) ?? 18;
  return formatUnits(amount, decimals);
}

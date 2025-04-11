import { TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { constants, utils } from "@across-protocol/sdk";
import { CONTRACT_ADDRESSES } from "../common";
import { BigNumberish } from "./BNUtils";
import { formatUnits } from "./SDKUtils";

const { ZERO_ADDRESS } = constants;

export const { fetchTokenInfo, getL2TokenAddresses } = utils;

export function getNativeTokenAddressForChain(chainId: number): string {
  return CONTRACT_ADDRESSES[chainId]?.nativeToken?.address ?? ZERO_ADDRESS;
}

export function getWrappedNativeTokenAddress(chainId: number): string {
  const tokenSymbol = utils.getNativeTokenSymbol(chainId);
  // If the native token is ETH, then we know the wrapped native token is WETH. Otherwise, some ERC20 token is the native token.
  // In PUBLIC_NETWORKS, the native token symbol is the symbol corresponding to the L1 token contract, so "W" should not be prepended
  // to the symbol.
  const wrappedTokenSymbol = tokenSymbol === "ETH" ? "WETH" : tokenSymbol;

  // Undefined returns should be caught and handled by consumers of this function.
  return TOKEN_SYMBOLS_MAP[wrappedTokenSymbol]?.addresses[chainId];
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

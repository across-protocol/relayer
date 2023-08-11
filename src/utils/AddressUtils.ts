import { TOKEN_SYMBOLS_MAP } from "@across-protocol/contracts-v2";
import { BigNumber } from ".";

export function compareAddresses(addressA: string, addressB: string): 1 | -1 | 0 {
  // Convert address strings to BigNumbers and then sort numerical value of the BigNumber, which sorts the addresses
  // effectively by their hex value.
  const bnAddressA = BigNumber.from(addressA);
  const bnAddressB = BigNumber.from(addressB);
  if (bnAddressA.gt(bnAddressB)) {
    return 1;
  } else if (bnAddressA.lt(bnAddressB)) {
    return -1;
  } else {
    return 0;
  }
}

/**
 * Resolve the token symbol for the given token address and chain ID.
 * @param tokenAddress The token address to resolve the symbol for.
 * @param chainId The chain ID to resolve the symbol for.
 * @returns The token symbol for the given token address and chain ID, or undefined if the token address is not
 * recognized.
 */
export function resolveTokenSymbol(tokenAddress: string, chainId: number): string | undefined {
  const tokenInfo = Object.values(TOKEN_SYMBOLS_MAP).find(({ addresses }) => addresses[chainId] === tokenAddress);
  return tokenInfo?.symbol;
}

/**
 * Resolve the token symbols for the given token addresses and chain ID.
 * @param tokenAddresses The token addresses to resolve the symbols for.
 * @param chainId The chain ID to resolve the symbols for.
 * @returns The token symbols for the given token addresses and chain ID. Undefined values are filtered out.
 * @see resolveTokenSymbol
 */
export function resolveTokenSymbols(tokenAddresses: string[], chainId: number): string[] {
  return tokenAddresses
    .map((tokenAddress) => resolveTokenSymbol(tokenAddress, chainId))
    .filter(Boolean);
}

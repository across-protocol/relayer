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

export function compareAddressesSimple(addressA: string, addressB: string): boolean {
  return addressA.toLowerCase() === addressB.toLowerCase();
}

/**
 * Match the token symbol for the given token address and chain ID.
 * @param tokenAddress The token address to resolve the symbol for.
 * @param chainId The chain ID to resolve the symbol for.
 * @returns The token symbols for the given token address and chain ID, or undefined if the token address is not
 * recognized.
 */
export function matchTokenSymbol(tokenAddress: string, chainId: number): string[] {
  // We can match one l1 token address on multiple symbols in some special cases, like ETH/WETH.
  return Object.values(TOKEN_SYMBOLS_MAP)
    .filter(({ addresses }) => addresses[chainId]?.toLowerCase() === tokenAddress.toLowerCase())
    .map(({ symbol }) => symbol);
}

/**
 * Match the token decimals for a given token symbol.
 * @param tokenSymbol Symbol of the token to query.
 * @returns The number of ERC20 decimals configured for the requested token.
 */
export function resolveTokenDecimals(tokenSymbol: string): number {
  const decimals = TOKEN_SYMBOLS_MAP[tokenSymbol]?.decimals;
  if (decimals === undefined) {
    throw new Error(`Unrecognized token symbol: ${tokenSymbol}`);
  }
  return decimals;
}

export function resolveTokenSymbols(tokenAddresses: string[], chainId: number): string[] {
  const tokenSymbols = Object.values(TOKEN_SYMBOLS_MAP);
  return tokenAddresses
    .map((tokenAddress) => {
      return tokenSymbols.find(({ addresses }) => addresses[chainId]?.toLowerCase() === tokenAddress.toLowerCase())
        ?.symbol;
    })
    .filter(Boolean);
}

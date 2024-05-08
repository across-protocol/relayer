import { TOKEN_SYMBOLS_MAP } from "@across-protocol/constants-v2";
import { BigNumber, ethers } from ".";

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
  if (addressA === undefined || addressB === undefined) {
    return false;
  }
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

/**
 * Resolves a list of token symbols for a list of token addresses and a chain ID.
 * @dev This function is dangerous because multiple token addresses can map to the same token symbol
 * so the output can be unexpected.
 * @param tokenAddresses The token addresses to resolve the symbols for.
 * @param chainId The chain ID to resolve the symbols for.
 * @returns The token symbols for the given token addresses and chain ID. Undefined symbols are filtered out.
 */
export function resolveTokenSymbols(tokenAddresses: string[], chainId: number): string[] {
  const tokenSymbols = Object.values(TOKEN_SYMBOLS_MAP);
  return tokenAddresses
    .map((tokenAddress) => {
      return tokenSymbols.find(({ addresses }) => addresses[chainId]?.toLowerCase() === tokenAddress.toLowerCase())
        ?.symbol;
    })
    .filter(Boolean);
}

export function getTokenAddress(tokenAddress: string, chainId: number, targetChainId: number): string {
  const tokenSymbol = resolveTokenSymbols([tokenAddress], chainId)[0];
  const targetAddress = TOKEN_SYMBOLS_MAP[tokenSymbol]?.addresses[targetChainId];
  if (!targetAddress) {
    throw new Error(`Could not resolve token address for token symbol ${tokenSymbol} on chain ${targetChainId}`);
  }
  return targetAddress;
}

export function checkAddressChecksum(tokenAddress: string): boolean {
  return ethers.utils.getAddress(tokenAddress) === tokenAddress;
}

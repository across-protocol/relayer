import { TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { BigNumber, compareAddressesSimple, ethers, getRemoteTokenForL1Token, isDefined } from ".";

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

export function includesAddressSimple(address: string | undefined, list: string[]): boolean {
  if (!isDefined(address)) {
    return false;
  }
  return list.filter((listAddress) => compareAddressesSimple(address, listAddress)).length > 0;
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
 * @notice Returns the token address for a given token address on a given chain ID and lets caller specify
 * whether they want the native or bridged USDC for an L2 chain, if the l1 token is USDC.
 * @param l1Token L1 token address
 * @param hubChainId L1 token chain
 * @param l2ChainId Chain on which the token address is requested
 * @param isNativeUsdc True if caller wants native USDC on L2, false if caller wants bridged USDC on L2
 * @returns L2 token address
 */
export function getTranslatedTokenAddress(
  l1Token: string,
  hubChainId: number,
  l2ChainId: number,
  isNativeUsdc = false
): string {
  // Base Case
  if (hubChainId === l2ChainId) {
    return l1Token;
  }
  // Native USDC or not USDC, we can just look up in the token map directly.
  if (isNativeUsdc || !compareAddressesSimple(l1Token, TOKEN_SYMBOLS_MAP.USDC.addresses[hubChainId])) {
    return getRemoteTokenForL1Token(l1Token, l2ChainId, { chainId: hubChainId });
  }
  // Handle USDC special case where there could be multiple versions of USDC on an L2: Bridged or Native
  const bridgedUsdcMapping = Object.values(TOKEN_SYMBOLS_MAP).find(
    ({ symbol, addresses }) =>
      symbol !== "USDC" && compareAddressesSimple(addresses[hubChainId], l1Token) && addresses[l2ChainId]
  );
  return bridgedUsdcMapping?.addresses[l2ChainId];
}

export function checkAddressChecksum(tokenAddress: string): boolean {
  return ethers.utils.getAddress(tokenAddress) === tokenAddress;
}

import { TOKEN_EQUIVALENCE_REMAPPING, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { constants, utils } from "@across-protocol/sdk";
import { CONTRACT_ADDRESSES } from "../common";
import { BigNumberish } from "./BNUtils";
import { formatUnits } from "./SDKUtils";
import { HubPoolClient } from "../clients";
import { isDefined } from "./TypeGuards";

const { ZERO_ADDRESS } = constants;

export const { fetchTokenInfo, getL2TokenAddresses } = utils;

export function getRemoteTokenForL1Token(
  l1Token: string,
  chainId: number | string,
  hubPoolClient: Pick<HubPoolClient, "chainId">
): string | undefined {
  const tokenMapping = Object.values(TOKEN_SYMBOLS_MAP).find(
    ({ addresses }) => addresses[hubPoolClient.chainId] === l1Token && isDefined(addresses[chainId])
  );
  if (!tokenMapping) {
    return undefined;
  }
  const l1TokenSymbol = TOKEN_EQUIVALENCE_REMAPPING[tokenMapping.symbol] ?? tokenMapping.symbol;
  return TOKEN_SYMBOLS_MAP[l1TokenSymbol]?.addresses[chainId] ?? tokenMapping.addresses[chainId];
}

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

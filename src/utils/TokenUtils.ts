import { constants, utils } from "@across-protocol/sdk-v2";
import { CONTRACT_ADDRESSES } from "../common";
import { BigNumberish, utils as ethersUtils } from "ethers";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants-v2";
const { ZERO_ADDRESS } = constants;

export const { fetchTokenInfo } = utils;

export function getL2TokenAddresses(l1TokenAddress: string): { [chainId: number]: string } {
  return Object.values(TOKEN_SYMBOLS_MAP).find((details) => {
    return details.addresses[CHAIN_IDs.MAINNET] === l1TokenAddress;
  })?.addresses;
}

export function getEthAddressForChain(chainId: number): string {
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
  return ethersUtils.formatUnits(amount, decimals);
}

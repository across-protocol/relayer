import { constants, utils } from "@across-protocol/sdk-v2";
import { CONTRACT_ADDRESSES } from "../common";
import { BigNumberish, utils as ethersUtils } from "ethers";
import { CHAIN_IDs } from "@across-protocol/constants-v2";
import { L1Token } from "../interfaces";
import { TOKEN_SYMBOLS_MAP } from ".";
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

export function getTokenInfo(l2TokenAddress: string, chainId: number): L1Token {
  // @dev This might give false positives if tokens on different networks have the same address. I'm not sure how
  // to get around this...
  const tokenObject = Object.values(TOKEN_SYMBOLS_MAP).find(({ addresses }) => addresses[chainId] === l2TokenAddress);
  if (!tokenObject) {
    throw new Error(
      `TokenUtils#getTokenInfo: Unable to resolve token in TOKEN_SYMBOLS_MAP for ${l2TokenAddress} on chain ${chainId}`
    );
  }
  return {
    address: l2TokenAddress,
    symbol: tokenObject.symbol,
    decimals: tokenObject.decimals,
  };
}

export function getL1TokenInfo(l2TokenAddress: string, chainId: number): L1Token {
  const tokenObject = Object.values(TOKEN_SYMBOLS_MAP).find(({ addresses }) => addresses[chainId] === l2TokenAddress);
  const l1TokenAddress = tokenObject?.addresses[CHAIN_IDs.MAINNET];
  if (!l1TokenAddress) {
    throw new Error(
      `TokenUtils#getL1TokenInfo: Unable to resolve l1 token address in TOKEN_SYMBOLS_MAP for L2 token ${l2TokenAddress} on chain ${chainId}`
    );
  }
  return {
    address: l1TokenAddress,
    symbol: tokenObject.symbol,
    decimals: tokenObject.decimals,
  };
}

/**
 * Format the given amount of tokens to the correct number of decimals for the given token symbol.
 * @param symbol The token symbol to format the amount for.
 * @param amount The amount to format.
 * @returns The formatted amount as a decimal-inclusive string.
 */
export function formatUnitsForToken(symbol: string, amount: BigNumberish): string {
  const decimals = TOKEN_SYMBOLS_MAP[symbol]?.decimals ?? 18;
  return ethersUtils.formatUnits(amount, decimals);
}

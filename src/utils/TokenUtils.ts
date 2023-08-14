import { constants, utils } from "@across-protocol/sdk-v2";
import { CONTRACT_ADDRESSES } from "../common";
const { TOKEN_SYMBOLS_MAP, CHAIN_IDs, ZERO_ADDRESS } = constants;

export const { fetchTokenInfo } = utils;

export const getL2TokenAddresses = (l1TokenAddress: string): { [chainId: number]: string } => {
  return Object.values(TOKEN_SYMBOLS_MAP).find((details) => {
    return details.addresses[CHAIN_IDs.MAINNET] === l1TokenAddress;
  })?.addresses;
};

export const getEthAddressForChain = (chainId: number): string => {
  return CONTRACT_ADDRESSES[chainId]?.eth?.address ?? ZERO_ADDRESS;
};

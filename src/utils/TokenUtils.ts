import { constants } from "@across-protocol/sdk-v2";

export const getL2TokenAddresses = (l1TokenAddress: string) => {
  return Object.values(constants.TOKEN_SYMBOLS_MAP).find((details) => {
    return details.addresses[constants.CHAIN_IDs.MAINNET] === l1TokenAddress;
  })?.addresses;
};

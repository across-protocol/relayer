import { TOKEN_MAP, CHAIN_ID_NAMES } from "../common";

export const getL2TokenAddresses = (l1TokenAddress: string) => {
  return Object.values(TOKEN_MAP).find((details) => {
    return details.addresses[CHAIN_ID_NAMES.MAINNET] === l1TokenAddress;
  })?.addresses;
};

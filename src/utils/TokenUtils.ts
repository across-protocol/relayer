import { constants } from "@across-protocol/sdk-v2";
import { Contract, ERC20, providers, Signer } from "./";
import { L1Token } from "../interfaces";
const { TOKEN_SYMBOLS_MAP, CHAIN_IDs } = constants;

type SignerOrProvider = providers.Provider | Signer;

export async function fetchTokenInfo(address: string, signerOrProvider: SignerOrProvider): Promise<L1Token> {
  const token = new Contract(address, ERC20.abi, signerOrProvider);
  const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
  return { address, symbol, decimals };
}

export const getL2TokenAddresses = (l1TokenAddress: string): { [chainId: number]: string } => {
  return Object.values(TOKEN_SYMBOLS_MAP).find((details) => {
    return details.addresses[CHAIN_IDs.MAINNET] === l1TokenAddress;
  })?.addresses;
};

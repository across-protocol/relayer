import { CHAIN_IDs } from "@across-protocol/constants";
import { Chain, defineChain } from "viem";

// Chains supported by Across that are not yet upstream in viem/chains.
export const CUSTOM_VIEM_CHAINS: Chain[] = [
  defineChain({
    id: CHAIN_IDs.ROBINHOOD,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    blockTime: 100,
    rpcUrls: {
      default: {
        http: ["https://rpc.chain.robinhood.com"],
      },
    },
    blockExplorers: {
      default: {
        name: "Robinhood Explorer",
        url: "https://explorer.chain.robinhood.com",
      },
    },
    contracts: {
      multicall3: {
        address: "0xca11bde05977b3631167028862be2a173976ca11",
      },
    },
    sourceId: CHAIN_IDs.MAINNET,
  }),
];

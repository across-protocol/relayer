import { ArbitrumNetwork } from "@arbitrum/sdk";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";

type PartialArbitrumNetwork = Omit<ArbitrumNetwork, "confirmPeriodBlocks"> & {
  challengePeriodSeconds: number;
  registered: boolean;
};
// These network configs are defined in the Arbitrum SDK, and we need to register them in the SDK's memory.
// We should export this out of a common file but we don't use this SDK elsewhere currently.
export const ARB_ORBIT_NETWORK_CONFIGS: PartialArbitrumNetwork[] = [
  {
    chainId: CHAIN_IDs.ROBINHOOD,
    name: "Robinhood",
    parentChainId: CHAIN_IDs.MAINNET,
    ethBridge: {
      bridge: "0xDf8755334ce7A73cCF6b581C02eA649AE3E864b3",
      inbox: "0x1A07cc4BD17E0118BdB54D70990D2158AbAD7a2D ",
      sequencerInbox: "0xBd0D173EEb87D57A09521c24388a12789F33ba96",
      outbox: "....", // TODO: Add correct address
      rollup: "0x23A19d23e89166adedbDcB432518AB01e4272D94",
    },
    challengePeriodSeconds: 6 * 60 * 60, // ~ 6 hours
    retryableLifetimeSeconds: 7 * 24 * 60 * 60,
    nativeToken: TOKEN_SYMBOLS_MAP.ETH.addresses[CHAIN_IDs.MAINNET],
    isTestnet: false,
    registered: false,
    // Must be set to true for L3's
    isCustom: false, // @TODO: Robinhood should be a L2?
  },
];

function getOrbitNetwork(chainId: number): PartialArbitrumNetwork | undefined {
  return ARB_ORBIT_NETWORK_CONFIGS.find((network) => network.chainId === chainId);
}
export function getArbitrumOrbitFinalizationTime(chainId: number): number {
  return getOrbitNetwork(chainId)?.challengePeriodSeconds ?? 7 * 60 * 60 * 24;
}

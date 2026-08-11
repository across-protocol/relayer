import { ArbitrumNetwork } from "@arbitrum/sdk";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { isDefined } from "./TypeGuards";

// Nominal L1 block time, used only to convert a rollup's confirmPeriodBlocks into an approximate wall-clock duration
// for event lookback windows. @dev Do not invert this to derive confirmPeriodBlocks: the Arbitrum SDK feeds that field
// straight into BigNumber.from(), so it must stay the exact on-chain integer.
const MAINNET_NOMINAL_BLOCK_TIME_SECONDS = 12;

type OrbitNetworkConfig = ArbitrumNetwork & {
  registered: boolean;
};
// These network configs are defined in the Arbitrum SDK, and we need to register them in the SDK's memory.
// We should export this out of a common file but we don't use this SDK elsewhere currently.
export const ARB_ORBIT_NETWORK_CONFIGS: OrbitNetworkConfig[] = [
  {
    chainId: CHAIN_IDs.ROBINHOOD,
    name: "Robinhood",
    parentChainId: CHAIN_IDs.MAINNET,
    ethBridge: {
      bridge: "0xDf8755334ce7A73cCF6b581C02eA649AE3E864b3",
      inbox: "0x1A07cc4BD17E0118BdB54D70990D2158AbAD7a2D",
      sequencerInbox: "0xBd0D173EEb87D57A09521c24388a12789F33ba96",
      outbox: "0xf0ce991ea4A0d2400A4AB49b20ae333f6Dce3DE9",
      rollup: "0x23A19d23e89166adedbDcB432518AB01e4272D94",
    },
    // Rollup.confirmPeriodBlocks() reports 45818 L1 blocks — Arbitrum's standard challenge period (~6.4 days).
    confirmPeriodBlocks: 45818,
    retryableLifetimeSeconds: 7 * 24 * 60 * 60,
    nativeToken: TOKEN_SYMBOLS_MAP.ETH.addresses[CHAIN_IDs.MAINNET],
    isTestnet: false,
    registered: false,
    isCustom: true,
  },
];

function getOrbitNetwork(chainId: number): OrbitNetworkConfig | undefined {
  return ARB_ORBIT_NETWORK_CONFIGS.find((network) => network.chainId === chainId);
}

export function getArbitrumOrbitFinalizationTime(chainId: number): number {
  const confirmPeriodBlocks = getOrbitNetwork(chainId)?.confirmPeriodBlocks;
  return isDefined(confirmPeriodBlocks) ? confirmPeriodBlocks * MAINNET_NOMINAL_BLOCK_TIME_SECONDS : 7 * 60 * 60 * 24;
}

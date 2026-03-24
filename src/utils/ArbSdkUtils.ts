import { ArbitrumNetwork } from "@arbitrum/sdk";

type PartialArbitrumNetwork = Omit<ArbitrumNetwork, "confirmPeriodBlocks"> & {
  challengePeriodSeconds: number;
  registered: boolean;
};
// These network configs are defined in the Arbitrum SDK, and we need to register them in the SDK's memory.
// We should export this out of a common file but we don't use this SDK elsewhere currently.
export const ARB_ORBIT_NETWORK_CONFIGS: PartialArbitrumNetwork[] = [];

function getOrbitNetwork(chainId: number): PartialArbitrumNetwork | undefined {
  return ARB_ORBIT_NETWORK_CONFIGS.find((network) => network.chainId === chainId);
}
export function getArbitrumOrbitFinalizationTime(chainId: number): number {
  return getOrbitNetwork(chainId)?.challengePeriodSeconds ?? 7 * 60 * 60 * 24;
}

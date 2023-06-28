import { PublicNetworks } from "@uma/common";

export function getNetworkName(networkId: number | string): string {
  try {
    const networkName = PublicNetworks[Number(networkId)].name;
    return networkName.charAt(0).toUpperCase() + networkName.slice(1);
  } catch (error) {
    if (Number(networkId) == 666) {
      return "Hardhat1";
    }
    if (Number(networkId) == 1337) {
      return "Hardhat2";
    }
    if (Number(networkId) == 421613) {
      return "ArbitrumGoerli";
    }
    if (Number(networkId) == 324) {
      return "ZkSync";
    }
    if (Number(networkId) == 280) {
      return "ZkSync-Goerli";
    }
    return "unknown";
  }
}

export function getNativeTokenSymbol(chainId: number | string): string {
  if (chainId.toString() === "137" || chainId.toString() === "80001") {
    return "MATIC";
  }
  return "ETH";
}

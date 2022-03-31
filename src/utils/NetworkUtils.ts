import { PublicNetworks } from "@uma/common";

export function getNetworkName(networkId: number): string {
  try {
    const networkName = PublicNetworks[networkId].name;
    return networkName.charAt(0).toUpperCase() + networkName.slice(1);
  } catch (error) {
    return "unknown";
  }
}

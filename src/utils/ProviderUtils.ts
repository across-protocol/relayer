import { ethers, providers } from "ethers";

export function getProvider(networkId: number, nodeQuorumThreshold: number = 1) {
  if (process.env[`RETRY_CONFIG_${networkId}`]) return getFallbackProvider(networkId, nodeQuorumThreshold);
  const nodeUrl = process.env[`NODE_URL_${networkId}`];
  if (!nodeUrl) throw new Error(`No NODE_URL_ for network ${networkId}`);
  return new ethers.providers.JsonRpcProvider(nodeUrl);
}

// Create a fallback provider. This provider type enforces that nodeQuorumThreshold of the total retry configs defined
// all agree in the data they return before returning the data to the provider user. This applies in the context of both
// events and state reads to ensure consistency and redundancy within the infrastructure. Set the priority to 1.
// This makes all providers equally weighted and should all be considered. Stall timeout is how long to wait for a node
// to reply before trying another node in the set provided. This would be the case when the number of nodes is more than
// the nodeQuorumThreshold (i.e using a 2 of 3 setup).
export function getFallbackProvider(networkId: number, nodeQuorumThreshold: number) {
  const nodeUrls = JSON.parse(process.env[`RETRY_CONFIG_${networkId}`]) || [];
  if (nodeUrls.length == 0) throw new Error(`No RETRY_CONFIG_ for network ${networkId}`);

  return new providers.FallbackProvider(
    nodeUrls.map((url) => {
      return { provider: new ethers.providers.JsonRpcProvider(url), priority: 1, stallTimeout: 2000, weight: 1 };
    }),
    nodeQuorumThreshold
  );
}

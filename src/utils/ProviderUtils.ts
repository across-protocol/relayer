import { ethers, providers } from "ethers";

export function getProvider(networkId: number, nodeQuorumThreshold: number = 1) {
  if (process.env[`RETRY_CONFIG_${networkId}`]) return getFallbackProvider(networkId, nodeQuorumThreshold);
  const nodeUrl = process.env[`NODE_URL_${networkId}`];
  if (!nodeUrl) throw new Error(`No NODE_URL_ for network ${networkId}`);
  return new ethers.providers.JsonRpcProvider(nodeUrl);
}

export function getFallbackProvider(networkId: number, nodeQuorumThreshold: number) {
  const nodeUrls = JSON.parse(process.env[`RETRY_CONFIG_${networkId}`]) || [];
  if (nodeUrls.length == 0) throw new Error(`No RETRY_CONFIG_ for network ${networkId}`);
  // Create a fallback provider. Set the priority to 1. This makes all providers equally weighted.
  // stallTimeout is how long to wait for a node to respond before trying another provider in the set.
  // At least nodeQuorumThreshold number of nodes must agree before any results are used.
  return new ethers.providers.FallbackProvider(
    nodeUrls.map((url) => {
      return { provider: new ethers.providers.JsonRpcProvider(url), priority: 1, stallTimeout: 2000, weight: 1 };
    }),
    nodeQuorumThreshold
  );
}

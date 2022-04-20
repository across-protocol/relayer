import { ethers, providers } from "ethers";

export function getProvider(networkId: number) {
  if (process.env[`RETRY_CONFIG_${networkId}`]) return getFallbackProvider(networkId);
  const nodeUrl = process.env[`NODE_URL_${networkId}`];
  if (!nodeUrl) throw new Error(`No NODE_URL_ for network ${networkId}`);
  return new ethers.providers.JsonRpcProvider(nodeUrl);
}

export function getFallbackProvider(networkId: number) {
  const nodeUrls = JSON.parse(process.env[`RETRY_CONFIG_${networkId}`]) || [];
  if (nodeUrls.length == 0) throw new Error(`No RETRY_CONFIG_ for network ${networkId}`);
  return new ethers.providers.FallbackProvider(
    nodeUrls.map((url) => {
      return { provider: new ethers.providers.JsonRpcProvider(url), priority: 1, stallTimeout: 1000, weight: 1 };
    }),
    2
  );
}

import { ethers, providers } from "ethers";

export function getProvider(networkId: number) {
  const nodeUrl = process.env[`NODE_URL_${networkId}`];
  if (!nodeUrl) throw new Error(`No node url for network ${networkId}`);
  return new ethers.providers.JsonRpcProvider(nodeUrl);
}

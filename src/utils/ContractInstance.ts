import { ethers } from "ethers";
import * as typechain from "@across-protocol/contracts-v2"; // This imports all typechain artifacts from the contracts-v2 package.

export function contractAt(name: string, address: string, signer: ethers.Wallet) {
  const typeChainArtifact = typechain[`${name}__factory`];
  if (!typeChainArtifact) throw new Error(`No contract factory for ${name}`);
  return typeChainArtifact.connect(address, signer);
}

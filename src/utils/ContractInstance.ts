import { getNetworkName, Contract, Wallet } from "./";

import { getContractArtifact } from "@across-protocol/contracts-v2";
import { PublicNetworks } from "@uma/common";

// Return an ethers contract instance for a deployed contract, imported from the Across-protocol contracts repo.
export function getDeployedContract(contractName: string, networkId: number, signer: Wallet): Contract {
  if (contractName === "SpokePool") contractName = castSpokePoolName(networkId);
  console.log("contractName", contractName);
  const artifact = getContractArtifact(contractName, networkId);
  if (!artifact) throw new Error(`Could not find artifact for contract ${contractName} on ${networkId}`);
  return new Contract(artifact.address, artifact.abi, signer);
}

// If the name of the contract is SpokePool then we need to apply a transformation on the name to get the correct
// contract name. For example, if the network is "mainnet" then the contract is called Ethereum_SpokePool.
export function castSpokePoolName(networkId: number): string {
  let networkName = getNetworkName(networkId);
  if (networkName == "Mainnet" || networkName == "Rinkeby" || networkName == "Kovan" || networkName == "Goerli")
    return "Ethereum_SpokePool";

  if (networkName.includes("-")) networkName = networkName.substring(0, networkName.indexOf("-"));
  return `${networkName}_SpokePool`;
}

import { getNetworkName, Contract, Signer, getDeployedAddress, getDeployedBlockNumber, CHAIN_IDs } from ".";

import * as typechain from "@across-protocol/contracts"; // TODO: refactor once we've fixed export from contract repo

// Return an ethers contract instance for a deployed contract, imported from the Across-protocol contracts repo.
export function getDeployedContract(contractName: string, networkId: number, signer?: Signer): Contract {
  try {
    const address = getDeployedAddress(contractName, networkId);
    // If the contractName is SpokePool then we need to modify it to find the correct contract factory artifact.
    const factoryName = contractName === "SpokePool" ? castSpokePoolName(networkId) : contractName;
    const artifact = typechain[`${[factoryName.replace("_", "")]}__factory`];
    return new Contract(address, artifact.abi, signer);
  } catch (error) {
    throw new Error(`Could not find address for contract ${contractName} on ${networkId}`);
  }
}

// If the name of the contract is SpokePool then we need to apply a transformation on the name to get the correct
// contract factory name. For example, if the network is "mainnet" then the contract is called Ethereum_SpokePool.
export function castSpokePoolName(networkId: number): string {
  let networkName = getNetworkName(networkId);
  if (networkName == "Mainnet" || networkName == "Rinkeby" || networkName == "Kovan" || networkName == "Goerli") {
    return "Ethereum_SpokePool";
  }

  if (networkName.includes("-")) {
    networkName = networkName.substring(0, networkName.indexOf("-"));
  }
  return `${networkName}_SpokePool`;
}

export function getParamType(contractName: string, functionName: string, paramName: string): string {
  const artifact = typechain[`${[contractName]}__factory`];
  const fragment = artifact.abi.find((fragment: { name: string }) => fragment.name === functionName);
  return fragment.inputs.find((input: { name: string }) => input.name === paramName) || "";
}

export function getDeploymentBlockNumber(contractName: string, networkId: number): number {
  try {
    return Number(getDeployedBlockNumber(contractName, networkId));
  } catch (error) {
    throw new Error(`Could not find deployment block for contract ${contractName} on ${networkId}`);
  }
}

// TODO: Once all other spokes are redeployed with tryMulticall, we can delete this function.
export function spokeHasTryMulticall(chainId: number): boolean {
  return [CHAIN_IDs.LISK, CHAIN_IDs.BLAST, CHAIN_IDs.LISK_SEPOLIA, CHAIN_IDs.BLAST_SEPOLIA].includes(chainId);
}

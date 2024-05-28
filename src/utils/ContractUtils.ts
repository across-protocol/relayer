import { getNetworkName, Contract, Signer, getDeployedAddress, getDeployedBlockNumber } from ".";

import * as typechain from "@across-protocol/contracts-v2"; // TODO: refactor once we've fixed export from contract repo
import { JsonFragment } from "@ethersproject/abi";
const abiLookup = typechain as unknown as Record<string, { abi: ReadonlyArray<JsonFragment> }>;

// Return an ethers contract instance for a deployed contract, imported from the Across-protocol contracts repo.
export function getDeployedContract(contractName: string, networkId: number, signer?: Signer): Contract {
  try {
    const address = getDeployedAddress(contractName, networkId);
    // If the contractName is SpokePool then we need to modify it to find the correct contract factory artifact.
    const factoryName = contractName === "SpokePool" ? castSpokePoolName(networkId) : contractName;
    const artifact = abiLookup[`${[factoryName.replace("_", "")]}__factory`];
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
  const artifact = abiLookup[`${[contractName]}__factory`];
  const fragment = artifact.abi.find(({ name }) => name === functionName);
  return fragment.inputs.find(({ name }) => name === paramName)?.type || "";
}

export function getDeploymentBlockNumber(contractName: string, networkId: number): number {
  try {
    return Number(getDeployedBlockNumber(contractName, networkId));
  } catch (error) {
    throw new Error(`Could not find deployment block for contract ${contractName} on ${networkId}`);
  }
}

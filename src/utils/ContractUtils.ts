import { getNetworkName, Contract, Wallet } from ".";

import { getDeployedAddress } from "@across-protocol/contracts-v2";
import * as typechain from "@across-protocol/contracts-v2"; //TODO: refactor once we've fixed export from contract repo

// Return an ethers contract instance for a deployed contract, imported from the Across-protocol contracts repo.
export function getDeployedContract(contractName: string, networkId: number, signer?: Wallet): Contract {
  try {
    if (contractName === "SpokePool") contractName = castSpokePoolName(networkId);

    const address = getDeployedAddress(contractName, networkId);
    const artifact = typechain[`${[contractName.replace("_", "")]}__factory`];
    return new Contract(address, artifact.abi, signer);
  } catch (error) {
    throw new Error(`Could not find address for contract ${contractName} on ${networkId}`);
  }
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

export function getParamType(contractName: string, functionName: string, paramName: string) {
  const artifact: any = typechain[`${[contractName]}__factory`];
  const fragment = artifact.abi.find((fragment) => fragment.name === functionName);
  return fragment!.inputs.find((input) => input.name === paramName) || "";
}

import * as typechain from "@across-protocol/contracts"; // TODO: refactor once we've fixed export from contract repo
import { CHAIN_IDs, getNetworkName, Contract, Signer, getDeployedAddress, getDeployedBlockNumber } from ".";

// Return an ethers contract instance for a deployed contract, imported from the Across-protocol contracts repo.
export function getDeployedContract(contractName: string, networkId: number, signer?: Signer): Contract {
  try {
    const address = getDeployedAddress(contractName, networkId);
    // If the contractName is SpokePool then we need to modify it to find the correct contract factory artifact.
    const factoryName = `${contractName === "SpokePool" ? castSpokePoolName(networkId) : contractName}__factory`;
    const artifact = typechain[factoryName];
    return new Contract(address, artifact.abi, signer);
  } catch (error) {
    throw new Error(`Could not find address for contract ${contractName} on ${networkId} (${error})`);
  }
}

// If the name of the contract is SpokePool then we need to apply a transformation on the name to get the correct
// contract factory name. For example, if the network is "mainnet" then the contract is called Ethereum_SpokePool.
export function castSpokePoolName(networkId: number): string {
  let networkName: string;
  switch (networkId) {
    case CHAIN_IDs.MAINNET:
    case CHAIN_IDs.SEPOLIA:
      return "Ethereum_SpokePool";
    case CHAIN_IDs.ARBITRUM:
      return "Arbitrum_SpokePool";
    case CHAIN_IDs.ZK_SYNC:
      return "ZkSync_SpokePool";
    case CHAIN_IDs.SONEIUM:
      return "Cher_SpokePool";
    case CHAIN_IDs.UNICHAIN || CHAIN_IDs.UNICHAIN_SEPOLIA:
      return "DoctorWho_SpokePool";
    default:
      networkName = getNetworkName(networkId);
  }

  return `${networkName.replace(" ", "")}_SpokePool`;
}

// For a chain ID and optional SpokePool address, return a Contract instance with the corresponding ABI.
export function getSpokePool(chainId: number, address?: string): Contract {
  const factoryName = castSpokePoolName(chainId);
  const artifact = typechain[`${factoryName}__factory`];
  return new Contract(address ?? getDeployedAddress("SpokePool", chainId), artifact.abi);
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

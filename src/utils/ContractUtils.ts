import * as typechain from "@across-protocol/sdk/typechain";
import {
  CHAIN_IDs,
  Contract,
  Signer,
  getDeployedAddress,
  getDeployedBlockNumber,
  EvmAddress,
  chainIsEvm,
  SvmAddress,
  Address,
} from ".";
import { CONTRACT_ADDRESSES } from "../common";

// Return an ethers contract instance for a deployed contract, imported from the Across-protocol contracts repo.
export function getDeployedContract(contractName: string, networkId: number, signer?: Signer): Contract {
  try {
    const address = getDeployedAddress(contractName, networkId);
    // If the contractName is SpokePool then we need to modify it to find the correct contract factory artifact.
    const artifact = typechain[`${contractName}__factory`];
    return new Contract(address, artifact.abi, signer);
  } catch (error) {
    throw new Error(`Could not find address for contract ${contractName} on ${networkId} (${error})`);
  }
}

// For a chain ID and optional CounterfactualDepositFactory address, return a Contract instance with the corresponding ABI.
export function getCounterfactualDepositFactory(chainId: number, address?: string): Contract {
  return new Contract(
    address ?? CONTRACT_ADDRESSES[chainId].counterfactualDepositFactory.address,
    CONTRACT_ADDRESSES[chainId].counterfactualDepositFactory.abi
  );
}

// For a chain ID and optional SpokePool address, return a Contract instance with the corresponding ABI.
export function getSpokePool(chainId: number, address?: string): Contract {
  const spokePool = getDeployedContract("SpokePool", chainId);
  return spokePool.connect(address ?? getDeployedAddress("SpokePool", chainId));
}

// For a chain ID and optional SpokePoolPeriphery address, return a Contract instance with the corresponding ABI.
export function getSpokePoolPeriphery(chainId: number, address?: string): Contract {
  return new Contract(
    address ?? CONTRACT_ADDRESSES[chainId].spokePoolPeriphery.address,
    CONTRACT_ADDRESSES[chainId].spokePoolPeriphery.abi
  );
}

export function getSpokePoolAddress(chainId: number): Address {
  const evmChain = chainIsEvm(chainId);
  const addr = getDeployedAddress(evmChain ? "SpokePool" : "SvmSpoke", chainId, true);
  return evmChain ? EvmAddress.from(addr) : SvmAddress.from(addr);
}

export function getHubPoolAddress(chainId: number): EvmAddress {
  return EvmAddress.from(getDeployedAddress("HubPool", chainId, true));
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

// The DstOft/Cctp handler contracts only exist on HyperEVM.
export function getDstOftHandler(): Contract {
  const factoryName = "DstOFTHandler";
  const artifact = typechain["HyperCoreFlowExecutor__factory"];
  const address =
    CONTRACT_ADDRESSES[CHAIN_IDs.HYPEREVM]?.dstOftHandler?.address ??
    getDeployedAddress(factoryName, CHAIN_IDs.HYPEREVM);
  return new Contract(address, artifact.abi);
}

export function getDstCctpHandler(): Contract {
  const factoryName = "SponsoredCCTPDstPeriphery";
  const artifact = typechain["HyperCoreFlowExecutor__factory"];
  const address =
    CONTRACT_ADDRESSES[CHAIN_IDs.HYPEREVM]?.dstCctpHandler?.address ??
    getDeployedAddress(factoryName, CHAIN_IDs.HYPEREVM);
  return new Contract(address, artifact.abi);
}

export function getSrcOftPeriphery(chainId: number): Contract {
  const factoryName = "SponsoredOFTSrcPeriphery";
  const artifact = typechain[`${factoryName}__factory`];
  return new Contract(getDeployedAddress(factoryName, chainId), artifact.abi);
}

import * as typechain from "@across-protocol/sdk/typechain";
import { JsonFragment, ParamType } from "@ethersproject/abi";
import {
  CHAIN_IDs,
  Contract,
  Signer,
  getDeployedAddress,
  getDeployedBlockNumber,
  EvmAddress,
  chainIsEvm,
  Address,
  assert,
  toAddressType,
  isDefined,
} from ".";
import { CONTRACT_ADDRESSES } from "../common";
import { isKeyOf } from "./TypeGuards";

function getTypechainAbi(contractName: string): readonly JsonFragment[] {
  const factoryName = `${contractName}__factory`;
  if (!isKeyOf(factoryName, typechain)) {
    throw new Error(`No typechain factory found for ${contractName}`);
  }
  const factory = typechain[factoryName];
  assert("abi" in factory, `Typechain export ${factoryName} has no abi`);
  return factory.abi as readonly JsonFragment[];
}

// Return an ethers contract instance for a deployed contract, imported from the Across-protocol contracts repo.
export function getDeployedContract(contractName: string, networkId: number, signer?: Signer): Contract {
  try {
    const address = getDeployedAddress(contractName, networkId);
    // If the contractName is SpokePool then we need to modify it to find the correct contract factory artifact.
    const abi = getTypechainAbi(contractName);
    return new Contract(address, abi, signer);
  } catch (error) {
    throw new Error(`Could not find address for contract ${contractName} on ${networkId} (${error})`);
  }
}

export function getCounterfactualDepositImplementationAddress(chainId: number): string {
  return CONTRACT_ADDRESSES[chainId].counterfactualDeposit.address;
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
  address ??= getDeployedAddress("SpokePoolPeriphery", chainId);
  return new Contract(address, CONTRACT_ADDRESSES[chainId].spokePoolPeriphery.abi);
}

// Uniswap Permit2 (same deployment address on supported EVM chains). Falls back to mainnet metadata when `chainId` has no entry.
export function getPermit2(chainId: number, address?: string): Contract {
  const permit2 = CONTRACT_ADDRESSES[chainId].permit2;
  return new Contract(address ?? permit2.address, permit2.abi);
}

export function getSpokePoolAddress(chainId: number): Address {
  const evmChain = chainIsEvm(chainId);
  const addr = getDeployedAddress(evmChain ? "SpokePool" : "SvmSpoke", chainId, true);
  return toAddressType(addr, chainId);
}

export function getHubPoolAddress(chainId: number): EvmAddress {
  return EvmAddress.from(getDeployedAddress("HubPool", chainId, true));
}

export function getParamType(contractName: string, functionName: string, paramName: string): ParamType {
  const abi = getTypechainAbi(contractName);
  const fragment = abi.find((fragment) => fragment.name === functionName);
  assert(isDefined(fragment?.inputs), `No inputs found for ${contractName}.${functionName}`);
  const param = fragment.inputs.find((input) => input.name === paramName);
  assert(isDefined(param), `No param ${paramName} found in ${contractName}.${functionName}`);
  return ParamType.from(param);
}

export function getDeploymentBlockNumber(contractName: string, networkId: number): number {
  try {
    return Number(getDeployedBlockNumber(contractName, networkId));
  } catch {
    throw new Error(`Could not find deployment block for contract ${contractName} on ${networkId}`);
  }
}

// The DstOft/Cctp handler contracts only exist on HyperEVM.
export function getDstOftHandler(): Contract {
  const factoryName = "DstOFTHandler";
  const artifact = typechain["HyperCoreFlowExecutor__factory"];
  const address = isDefined(process.env.DST_OFT_HANDLER)
    ? process.env.DST_OFT_HANDLER
    : (CONTRACT_ADDRESSES[CHAIN_IDs.HYPEREVM]?.dstOftHandler?.address ??
      getDeployedAddress(factoryName, CHAIN_IDs.HYPEREVM));
  return new Contract(address, artifact.abi);
}

export function getDstCctpHandler(): Contract {
  const factoryName = "SponsoredCCTPDstPeriphery";
  const artifact = typechain["HyperCoreFlowExecutor__factory"];
  const address = isDefined(process.env.DST_CCTP_HANDLER)
    ? process.env.DST_CCTP_HANDLER
    : (CONTRACT_ADDRESSES[CHAIN_IDs.HYPEREVM]?.dstCctpHandler?.address ??
      getDeployedAddress(factoryName, CHAIN_IDs.HYPEREVM));
  return new Contract(address, artifact.abi);
}

export function getSrcOftPeriphery(chainId: number): Contract {
  const factoryName = "SponsoredOFTSrcPeriphery";
  const artifact = typechain[`${factoryName}__factory`];
  return new Contract(getDeployedAddress(factoryName, chainId), artifact.abi);
}

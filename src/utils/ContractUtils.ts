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
  chainIsTvm,
  TvmAddress,
} from ".";
import { CONTRACT_ADDRESSES, getContractEntry, getContractAbi } from "../common";
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
import COUNTERFACTUAL_DEPOSIT_FACTORY_ABI from "../common/abi/CounterfactualDepositFactory.json";
import { TronWeb } from "tronweb";

/**
 * Returns an address string suitable for ethers / EVM JSON-RPC (`0x` + 20 bytes).
 * On TVM, deployment metadata may use Tron base58 — that case is normalized; otherwise unchanged.
 */
export function getEthersCompatibleAddress(chainId: number, address: string): string {
  if (chainIsTvm(chainId) && TronWeb.isAddress(address)) {
    return TvmAddress.from(address).toEvmAddress();
  }
  return address;
}

// Return an ethers contract instance for a deployed contract, imported from the Across-protocol contracts repo.
export function getDeployedContract(contractName: string, networkId: number, signer?: Signer): Contract {
  try {
    const deployed = getDeployedAddress(contractName, networkId);
    assert(isDefined(deployed), `No deployed address for ${contractName} on ${networkId}`);
    const address = getEthersCompatibleAddress(networkId, deployed);
    // If the contractName is SpokePool then we need to modify it to find the correct contract factory artifact.
    const abi = getTypechainAbi(contractName);
    return new Contract(address, abi, signer);
  } catch (error) {
    throw new Error(`Could not find address for contract ${contractName} on ${networkId} (${error})`);
  }
}

// For a CounterfactualDepositFactory address, return a Contract instance with the corresponding ABI.
export function getCounterfactualDepositFactory(address: string): Contract {
  return new Contract(address, COUNTERFACTUAL_DEPOSIT_FACTORY_ABI);
}

// For a chain ID and optional SpokePool address, return a Contract instance with the corresponding ABI.
export function getSpokePool(chainId: number, address?: string): Contract {
  const spokePool = getDeployedContract("SpokePool", chainId);

  return address ? spokePool.connect(address) : spokePool;
}

// For a chain ID and optional SpokePoolPeriphery address, return a Contract instance with the corresponding ABI.
export function getSpokePoolPeriphery(chainId: number, address?: string): Contract {
  const resolved = address ?? getDeployedAddress("SpokePoolPeriphery", chainId);
  assert(isDefined(resolved), `No SpokePoolPeriphery address for chain ${chainId}`);
  return new Contract(getEthersCompatibleAddress(chainId, resolved), getContractAbi(chainId, "spokePoolPeriphery"));
}

// Uniswap Permit2 (same deployment address on supported EVM chains). Falls back to mainnet metadata when `chainId` has no entry.
export function getPermit2(chainId: number, address?: string): Contract {
  const permit2 = getContractEntry(chainId, "permit2");
  return new Contract(address ?? permit2.address, permit2.abi);
}

export function getSpokePoolAddress(chainId: number): Address {
  const evmChain = chainIsEvm(chainId);
  const addr = getDeployedAddress(evmChain ? "SpokePool" : "SvmSpoke", chainId, true);
  assert(isDefined(addr), `No SpokePool deployment found for chain ${chainId}`);
  return toAddressType(addr, chainId);
}

export function getHubPoolAddress(chainId: number): EvmAddress {
  const addr = getDeployedAddress("HubPool", chainId, true);
  assert(isDefined(addr), `No HubPool deployment found for chain ${chainId}`);
  return EvmAddress.from(addr);
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
  assert(isDefined(address), `No address found for ${factoryName} on HyperEVM`);
  return new Contract(address, artifact.abi);
}

export function getDstCctpHandler(): Contract {
  const factoryName = "SponsoredCCTPDstPeriphery";
  const artifact = typechain["HyperCoreFlowExecutor__factory"];
  const address = isDefined(process.env.DST_CCTP_HANDLER)
    ? process.env.DST_CCTP_HANDLER
    : (CONTRACT_ADDRESSES[CHAIN_IDs.HYPEREVM]?.dstCctpHandler?.address ??
      getDeployedAddress(factoryName, CHAIN_IDs.HYPEREVM));
  assert(isDefined(address), `No address found for ${factoryName} on HyperEVM`);
  return new Contract(address, artifact.abi);
}

export function getSrcOftPeriphery(chainId: number): Contract {
  const factoryName = "SponsoredOFTSrcPeriphery";
  const artifact = typechain[`${factoryName}__factory`];
  const address = getDeployedAddress(factoryName, chainId);
  assert(isDefined(address), `No deployed address for ${factoryName} on chain ${chainId}`);
  return new Contract(address, artifact.abi);
}

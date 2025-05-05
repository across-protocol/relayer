import { ethers, Provider, Signer } from ".";
import { CONTRACT_ADDRESSES } from "../common/ContractAddresses";

/**
 * Retrieves an ethers.Contract instance for the SP1Helios contract on the specified chain.
 * @throws {Error} If the SP1Helios contract address or ABI is not found for the given chainId in CONTRACT_ADDRESSES.
 */
export function getSp1HeliosContract(chainId: number, signerOrProvider: Signer | Provider): ethers.Contract {
  const { address: sp1HeliosAddress, abi: sp1HeliosAbi } = CONTRACT_ADDRESSES[chainId].sp1Helios;
  if (!sp1HeliosAddress || !sp1HeliosAbi) {
    throw new Error(`SP1Helios contract not found for chain ${chainId}. Cannot verify Helios messages.`);
  }
  return new ethers.Contract(sp1HeliosAddress, sp1HeliosAbi as any, signerOrProvider);
}

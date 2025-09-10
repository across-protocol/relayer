import { ethers } from "ethers";
import { BigNumber, Signer, Provider } from ".";
import { CONTRACT_ADDRESSES } from "../common";

/**
 * Calculates the storage slot in the HubPoolStore contract for a given nonce.
 * This assumes the data is stored in a mapping at slot 0, keyed by nonce.
 * storage_slot = keccak256(h(k) . h(p)) where k = nonce, p = mapping slot position (0)
 */
export function calculateHubPoolStoreStorageSlot(nonce: BigNumber): string {
  const mappingSlotPosition = 0; // The relayMessageCallData mapping is at slot 0

  // Ensure nonce and slot position are correctly padded to 32 bytes (64 hex chars + 0x prefix)
  const paddedNonce = ethers.utils.hexZeroPad(nonce.toHexString(), 32);
  const paddedSlot = ethers.utils.hexZeroPad(BigNumber.from(mappingSlotPosition).toHexString(), 32);

  // Concatenate the padded key (nonce) and slot position
  // ethers.utils.concat expects Uint8Array or hex string inputs
  const concatenated = ethers.utils.concat([paddedNonce, paddedSlot]);

  // Calculate the Keccak256 hash
  const storageSlot = ethers.utils.keccak256(concatenated);

  return storageSlot;
}

/**
 * Retrieves an ethers.Contract instance for the HubPoolStore contract on the specified chain.
 * @throws {Error} If the HubPoolStore contract address or ABI is not found for the given chainId in CONTRACT_ADDRESSES.
 */
export function getHubPoolStoreContract(chainId: number, signerOrProvider: Signer | Provider): ethers.Contract {
  const hubPoolStoreInfo = CONTRACT_ADDRESSES[chainId]?.hubPoolStore;
  if (!hubPoolStoreInfo?.address || !hubPoolStoreInfo.abi) {
    throw new Error(`HubPoolStore contract address or ABI not found for chain ${chainId}.`);
  }

  return new ethers.Contract(hubPoolStoreInfo.address, hubPoolStoreInfo.abi as any, signerOrProvider);
}

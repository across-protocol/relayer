import { ethers, Provider, Signer } from ".";
import SP1_HELIOS_ABI from "../common/abi/SP1Helios.json";
import UNIVERSAL_SPOKE_ABI from "../common/abi/Universal_SpokePool.json";

/**
 * Retrieves an ethers.Contract instance for the SP1Helios contract.
 * The SP1Helios contract address is fetched from the `helios()` view function of the `evmSpokePool`.
 *
 * @param evmSpokePool SpokePool contract instance with a `helios()` view function.
 * @param signerOrProvider Signer or Provider for the SP1Helios contract.
 * @returns Promise resolving to an SP1Helios ethers.Contract instance.
 * @throws If `helios()` call fails or `evmSpokePool` is invalid.
 */
export async function getSp1HeliosContractEVM(
  evmSpokePool: ethers.Contract,
  signerOrProvider: Signer | Provider
): Promise<ethers.Contract> {
  const universalSpokePoolContract = new ethers.Contract(
    evmSpokePool.address,
    UNIVERSAL_SPOKE_ABI,
    evmSpokePool.provider
  );
  const heliosAddress = await universalSpokePoolContract.helios();
  return new ethers.Contract(heliosAddress, SP1_HELIOS_ABI, signerOrProvider);
}

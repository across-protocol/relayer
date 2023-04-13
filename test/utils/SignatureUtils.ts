import { ethers, SignerWithAddress, BigNumber } from "@across-protocol/contracts-v2/dist/test-utils";

// This function only works if the signer is the depositor and the recipient, and the updated message is 0x.
export async function signForSpeedUp(
  signer: SignerWithAddress,
  deposit: { depositId: number; originChainId: number },
  newRelayerFeePct: BigNumber
): Promise<string> {
  const messageHash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["uint32", "uint256", "int64", "address", "bytes"],
      [deposit.depositId, deposit.originChainId, newRelayerFeePct, signer.address, "0x"]
    )
  );
  return await signer.signMessage(ethers.utils.arrayify(messageHash));
}

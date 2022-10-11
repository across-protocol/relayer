import { baseSpeedUpString } from "./../constants";
import { ethers, SignerWithAddress, BigNumber } from "@across-protocol/contracts-v2/dist/test-utils";

export async function signForSpeedUp(
  signer: SignerWithAddress,
  deposit: { depositId: number; originChainId: number },
  newRelayeraFeePct: BigNumber
): Promise<string> {
  const messageHash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["string", "uint64", "uint32", "uint32"],
      [baseSpeedUpString, newRelayeraFeePct, deposit.depositId, deposit.originChainId]
    )
  );
  return await signer.signMessage(ethers.utils.arrayify(messageHash));
}

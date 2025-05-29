import { SlowFillLeaf, RelayData, RelayerRefundLeaf } from "../interfaces";
import { ethers, toAddressType } from "./";
import { address } from "@solana/kit";
import { SvmSpokeClient } from "@across-protocol/contracts";

export type MakeOptional<Type, Key extends keyof Type> = Omit<Type, Key> & Partial<Pick<Type, Key>>;

export type AnyObject = Record<string, unknown>;

export function toSvmSlowFillLeaf(slowFillLeaf: SlowFillLeaf): SvmSpokeClient.SlowFill {
  return {
    relayData: toSvmRelayData(slowFillLeaf.relayData),
    chainId: BigInt(slowFillLeaf.chainId),
    updatedOutputAmount: slowFillLeaf.updatedOutputAmount.toBigInt(),
  };
}

// @todo Once we change the interface of `RelayData`, we won't need to cast the input addresses to an `Address` SDK type.
// @dev All address inputs are casted to an address type since it is not yet guaranteed that `relayData` will be a hex string (or a base58 address).
export function toSvmRelayData(relayData: RelayData): SvmSpokeClient.RelayData {
  return {
    originChainId: BigInt(relayData.originChainId),
    depositor: address(toAddressType(relayData.depositor).toBase58()),
    recipient: address(toAddressType(relayData.recipient).toBase58()),
    depositId: ethers.utils.arrayify(ethers.utils.hexZeroPad(relayData.depositId.toHexString(), 32)),
    inputToken: address(toAddressType(relayData.inputToken).toBase58()),
    outputToken: address(toAddressType(relayData.outputToken).toBase58()),
    inputAmount: relayData.inputAmount.toBigInt(),
    outputAmount: relayData.outputAmount.toBigInt(),
    message: Uint8Array.from(Buffer.from(relayData.message.slice(2), "hex")),
    fillDeadline: relayData.fillDeadline,
    exclusiveRelayer: address(toAddressType(relayData.exclusiveRelayer).toBase58()),
    exclusivityDeadline: relayData.exclusivityDeadline,
  };
}

export function toSvmRelayerRefundLeaf(relayerRefundLeaf: RelayerRefundLeaf): SvmSpokeClient.RelayerRefundLeaf {
  return {
    amountToReturn: relayerRefundLeaf.amountToReturn.toBigInt(),
    chainId: BigInt(relayerRefundLeaf.chainId),
    refundAmounts: relayerRefundLeaf.refundAmounts.map((refundAmount) => refundAmount.toBigInt()),
    leafId: relayerRefundLeaf.leafId,
    mintPublicKey: address(toAddressType(relayerRefundLeaf.l2TokenAddress).toBase58()),
    refundAddresses: relayerRefundLeaf.refundAddresses.map((refundAddress) =>
      address(toAddressType(refundAddress).toBase58())
    ),
  };
}

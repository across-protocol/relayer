import { SlowFillLeaf, RelayData, RelayerRefundLeaf } from "../interfaces";
import { ethers } from "./";
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

export function toSvmRelayData(relayData: RelayData): SvmSpokeClient.RelayData {
  return {
    originChainId: BigInt(relayData.originChainId),
    depositor: address(relayData.depositor.toBase58()),
    recipient: address(relayData.recipient.toBase58()),
    depositId: ethers.utils.arrayify(ethers.utils.hexZeroPad(relayData.depositId.toHexString(), 32)),
    inputToken: address(relayData.inputToken.toBase58()),
    outputToken: address(relayData.outputToken.toBase58()),
    inputAmount: ethers.utils.arrayify(ethers.utils.hexZeroPad(relayData.inputAmount.toHexString(), 32)),
    outputAmount: relayData.outputAmount.toBigInt(),
    message: Uint8Array.from(Buffer.from(relayData.message.slice(2), "hex")),
    fillDeadline: relayData.fillDeadline,
    exclusiveRelayer: address(relayData.exclusiveRelayer.toBase58()),
    exclusivityDeadline: relayData.exclusivityDeadline,
  };
}

export function toSvmRelayerRefundLeaf(relayerRefundLeaf: RelayerRefundLeaf): SvmSpokeClient.RelayerRefundLeaf {
  return {
    amountToReturn: relayerRefundLeaf.amountToReturn.toBigInt(),
    chainId: BigInt(relayerRefundLeaf.chainId),
    refundAmounts: relayerRefundLeaf.refundAmounts.map((refundAmount) => refundAmount.toBigInt()),
    leafId: relayerRefundLeaf.leafId,
    mintPublicKey: address(relayerRefundLeaf.l2TokenAddress.toBase58()),
    refundAddresses: relayerRefundLeaf.refundAddresses.map((refundAddress) => address(refundAddress.toBase58())),
  };
}

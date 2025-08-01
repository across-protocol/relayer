import { SlowFillLeaf, RelayerRefundLeaf } from "../interfaces";
import { toSvmRelayData } from "./";
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

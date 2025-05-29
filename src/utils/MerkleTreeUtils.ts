import { MerkleTree, EMPTY_MERKLE_ROOT, SvmSpokeClient } from "@across-protocol/contracts";
import { address } from "@solana/kit";
import { RelayerRefundLeaf, RelayerRefundLeafWithGroup, SlowFillLeaf } from "../interfaces";
import { getParamType, utils, chainIsEvm, toAddressType } from ".";
import _ from "lodash";
import { convertRelayDataParamsToBytes32 } from "./DepositUtils";

export function buildSlowRelayTree(relays: SlowFillLeaf[]): MerkleTree<SlowFillLeaf> {
  const hashFn = (_input: SlowFillLeaf) => {
    // Clone the input so we can mutate it.
    const input = _.cloneDeep(_input);
    input.relayData = convertRelayDataParamsToBytes32(input.relayData);
    if (chainIsEvm(input.chainId)) {
      const verifyFn = "verifyV3SlowRelayFulfillment";
      const paramType = getParamType("MerkleLibTest", verifyFn, "slowFill");
      return utils.keccak256(utils.defaultAbiCoder.encode([paramType], [input]));
    }
    // Map the slow fill leaf to the correct schema.
    const slowFillLeafEncoder = SvmSpokeClient.getSlowFillEncoder();
    const _relayData = input.relayData;
    const relayData: SvmSpokeClient.RelayData = {
      depositor: convertToSvmAddress(_relayData.depositor),
      recipient: convertToSvmAddress(_relayData.recipient),
      exclusiveRelayer: convertToSvmAddress(_relayData.exclusiveRelayer),
      inputToken: convertToSvmAddress(_relayData.inputToken),
      outputToken: convertToSvmAddress(_relayData.outputToken),
      inputAmount: _relayData.inputAmount.toBigInt(),
      outputAmount: _relayData.outputAmount.toBigInt(),
      originChainId: BigInt(_relayData.originChainId),
      depositId: Uint8Array.from(Buffer.from(_relayData.depositId.toHexString().slice(2), "hex")),
      fillDeadline: _relayData.fillDeadline,
      exclusivityDeadline: _relayData.exclusivityDeadline,
      message: Uint8Array.from(Buffer.from(_relayData.message.slice(2), "hex")),
    };
    const slowFill: SvmSpokeClient.SlowFillArgs = {
      relayData,
      chainId: input.chainId,
      updatedOutputAmount: input.updatedOutputAmount.toBigInt(),
    };
    const serializedData = slowFillLeafEncoder.encode(slowFill);
    const contentToHash = Buffer.concat([Buffer.alloc(64, 0), new Uint8Array(serializedData)]);
    return utils.keccak256(contentToHash);
  };
  return new MerkleTree(relays, hashFn);
}

export function buildRelayerRefundTree(relayerRefundLeaves: RelayerRefundLeaf[]): MerkleTree<RelayerRefundLeaf> {
  for (let i = 0; i < relayerRefundLeaves.length; i++) {
    // The 2 provided parallel arrays must be of equal length.
    if (relayerRefundLeaves[i].refundAddresses.length !== relayerRefundLeaves[i].refundAmounts.length) {
      throw new Error("Provided lef arrays are not of equal length");
    }
  }

  const paramType = getParamType("MerkleLibTest", "verifyRelayerRefund", "refund");
  const hashFn = (input: RelayerRefundLeaf) => {
    if (chainIsEvm(input.chainId)) {
      return utils.keccak256(utils.defaultAbiCoder.encode([paramType], [input]));
    }
    // Map the relayer refund leaf to the correct schema.
    const relayerRefundEncoder = SvmSpokeClient.getRelayerRefundLeafEncoder();
    const relayerRefundLeaf: SvmSpokeClient.RelayerRefundLeafArgs = {
      amountToReturn: input.amountToReturn.toBigInt(),
      chainId: input.chainId,
      refundAmounts: input.refundAmounts.map((bnAmount) => bnAmount.toBigInt()),
      leafId: input.leafId,
      mintPublicKey: convertToSvmAddress(input.l2TokenAddress),
      refundAddresses: input.refundAddresses.map(convertToSvmAddress),
    };
    const serializedData = relayerRefundEncoder.encode(relayerRefundLeaf);
    const contentToHash = Buffer.concat([Buffer.alloc(64, 0), new Uint8Array(serializedData)]);
    return utils.keccak256(contentToHash);
  };
  return new MerkleTree<RelayerRefundLeaf>(relayerRefundLeaves, hashFn);
}

// Local utility for converting a hex or base58 string into a solana kit Address.
const convertToSvmAddress = (stringAddress: string) => {
  return address(toAddressType(stringAddress).toBase58());
};

export { MerkleTree, RelayerRefundLeaf, RelayerRefundLeafWithGroup, EMPTY_MERKLE_ROOT };

import { MerkleTree, EMPTY_MERKLE_ROOT, SvmSpokeClient } from "@across-protocol/contracts";
import { RelayerRefundLeaf, RelayerRefundLeafWithGroup, SlowFillLeaf } from "../interfaces";
import {
  getParamType,
  utils,
  toSvmRelayerRefundLeaf,
  toSvmSlowFillLeaf,
  chainIsEvm,
  convertRelayDataParamsToBytes32,
} from ".";
import _ from "lodash";

export function buildSlowRelayTree(relays: SlowFillLeaf[]): MerkleTree<SlowFillLeaf> {
  const hashFn = (_input: SlowFillLeaf) => {
    // Clone the input so we can mutate it.
    const input = _.cloneDeep(_input);
    if (chainIsEvm(input.chainId)) {
      const verifyFn = "verifyV3SlowRelayFulfillment";
      const paramType = getParamType("MerkleLibTest", verifyFn, "slowFill");
      const ethersSlowFillLeaf = {
        ...input,
        relayData: convertRelayDataParamsToBytes32(input.relayData),
      };
      return utils.keccak256(utils.defaultAbiCoder.encode([paramType], [ethersSlowFillLeaf]));
    } else {
      const slowFillLeafEncoder = SvmSpokeClient.getSlowFillEncoder();
      const kitSlowFillLeaf = toSvmSlowFillLeaf(input);
      const serializedData = slowFillLeafEncoder.encode(kitSlowFillLeaf);
      const contentToHash = Buffer.concat([Buffer.alloc(64, 0), new Uint8Array(serializedData)]);
      return utils.keccak256(contentToHash);
    }
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
      const ethersRelayerRefundLeaf = {
        ...input,
        l2TokenAddress: input.l2TokenAddress.toEvmAddress(),
        refundAddresses: input.refundAddresses.map((refundAddress) => refundAddress.toEvmAddress()),
      };
      return utils.keccak256(utils.defaultAbiCoder.encode([paramType], [ethersRelayerRefundLeaf]));
    } else {
      const relayerRefundEncoder = SvmSpokeClient.getRelayerRefundLeafEncoder();
      const kitRelayerRefundLeaf = toSvmRelayerRefundLeaf(input);
      const serializedData = relayerRefundEncoder.encode(kitRelayerRefundLeaf);
      const contentToHash = Buffer.concat([Buffer.alloc(64, 0), new Uint8Array(serializedData)]);
      return utils.keccak256(contentToHash);
    }
  };
  return new MerkleTree<RelayerRefundLeaf>(relayerRefundLeaves, hashFn);
}

export { MerkleTree, RelayerRefundLeaf, RelayerRefundLeafWithGroup, EMPTY_MERKLE_ROOT };

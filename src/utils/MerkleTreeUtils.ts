import { MerkleTree, EMPTY_MERKLE_ROOT } from "@across-protocol/contracts";
import { RelayerRefundLeaf, RelayerRefundLeafWithGroup, V3SlowFillLeaf } from "../interfaces";
import { getParamType, utils } from ".";

export function buildSlowRelayTree(relays: V3SlowFillLeaf[]): MerkleTree<V3SlowFillLeaf> {
  const hashFn = (input: V3SlowFillLeaf) => {
    const verifyFn = "verifyV3SlowRelayFulfillment";
    const paramType = getParamType("MerkleLibTest", verifyFn, "slowFill");
    return utils.keccak256(utils.defaultAbiCoder.encode([paramType], [input]));
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
  const hashFn = (input: RelayerRefundLeaf) => utils.keccak256(utils.defaultAbiCoder.encode([paramType], [input]));
  return new MerkleTree<RelayerRefundLeaf>(relayerRefundLeaves, hashFn);
}

export { MerkleTree, RelayerRefundLeaf, RelayerRefundLeafWithGroup, EMPTY_MERKLE_ROOT };

import { getParamType, utils } from ".";
import { PoolRebalanceLeaf, RelayerRefundLeaf, RelayerRefundLeafWithGroup, SlowFillLeaf } from "../interfaces";
import { MerkleTree, EMPTY_MERKLE_ROOT } from "@across-protocol/contracts-v2";

export function buildSlowRelayTree(relays: SlowFillLeaf[]): MerkleTree<SlowFillLeaf> {
  const paramType = getParamType("MerkleLibTest", "verifySlowRelayFulfillment", "slowFill");
  const hashFn = (input: SlowFillLeaf) => {
    return utils.keccak256(utils.defaultAbiCoder.encode([paramType], [input]));
  };
  return new MerkleTree(relays, hashFn);
}

export function buildPoolRebalanceLeafTree(poolRebalanceLeaves: PoolRebalanceLeaf[]): MerkleTree<PoolRebalanceLeaf> {
  for (let i = 0; i < poolRebalanceLeaves.length; i++) {
    // The 4 provided parallel arrays must be of equal length. Running Balances can optionally be 2x the length
    if (
      poolRebalanceLeaves[i].l1Tokens.length !== poolRebalanceLeaves[i].bundleLpFees.length ||
      poolRebalanceLeaves[i].netSendAmounts.length !== poolRebalanceLeaves[i].bundleLpFees.length
    ) {
      throw new Error("Provided lef arrays are not of equal length");
    }
    if (
      poolRebalanceLeaves[i].runningBalances.length !== poolRebalanceLeaves[i].bundleLpFees.length * 2 &&
      poolRebalanceLeaves[i].runningBalances.length !== poolRebalanceLeaves[i].bundleLpFees.length
    ) {
      throw new Error("Running balances length unexpected");
    }
  }

  const paramType = getParamType("MerkleLibTest", "verifyPoolRebalance", "rebalance");
  const hashFn = (input: PoolRebalanceLeaf) => utils.keccak256(utils.defaultAbiCoder.encode([paramType], [input]));
  return new MerkleTree<PoolRebalanceLeaf>(poolRebalanceLeaves, hashFn);
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

import { MerkleTree, EMPTY_MERKLE_ROOT } from "@across-protocol/contracts";
import { RelayerRefundLeaf, RelayerRefundLeafWithGroup, SlowFillLeaf } from "../interfaces";
import { getParamType, utils, toBytes32 } from ".";
import _ from "lodash";

const SLOW_FILL_ADDRESS_TYPES = ["depositor", "recipient", "exclusiveRelayer", "inputToken", "outputToken"];
export function buildSlowRelayTree(relays: SlowFillLeaf[]): MerkleTree<SlowFillLeaf> {
  const hashFn = (_input: SlowFillLeaf) => {
    // Clone the input so we can mutate it.
    const input = _.cloneDeep(_input);
    const verifyFn = "verifyV3SlowRelayFulfillment";
    const paramType = getParamType("MerkleLibTest", verifyFn, "slowFill");
    // In case the input contains bytes20 representations of addresses, cast them to bytes32 to match the contract's
    // V3RelayData type.
    Object.entries(input.relayData)
      .filter(([key]) => SLOW_FILL_ADDRESS_TYPES.includes(key))
      .forEach(([key, field]) => {
        input.relayData[key] = toBytes32(field);
      });
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

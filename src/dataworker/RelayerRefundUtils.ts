import { Refund, RelayerRefundLeaf, RelayerRefundLeafWithGroup, SpokePoolTargetBalance } from "../interfaces";
import { BigNumber, bnZero, compareAddresses, getNetSendAmountForL1Token } from "../utils";

export function getAmountToReturnForRelayerRefundLeaf(
  spokePoolTargetBalance: SpokePoolTargetBalance,
  runningBalanceForLeaf: BigNumber
): BigNumber {
  const netSendAmountForLeaf = getNetSendAmountForL1Token(spokePoolTargetBalance, runningBalanceForLeaf);
  return netSendAmountForLeaf.lt(bnZero) ? netSendAmountForLeaf.mul(-1) : bnZero;
}

export function sortRefundAddresses(refunds: Refund): string[] {
  const deepCopy = { ...refunds };
  return [...Object.keys(deepCopy)].sort((addressA, addressB) => {
    if (deepCopy[addressA].gt(deepCopy[addressB])) {
      return -1;
    }
    if (deepCopy[addressA].lt(deepCopy[addressB])) {
      return 1;
    }
    const sortOutput = compareAddresses(addressA, addressB);
    if (sortOutput !== 0) {
      return sortOutput;
    } else {
      throw new Error("Unexpected matching address");
    }
  });
}

// Sort leaves by chain ID and then L2 token address in ascending order. Assign leaves unique, ascending ID's
// beginning from 0.
export function sortRelayerRefundLeaves(relayerRefundLeaves: RelayerRefundLeafWithGroup[]): RelayerRefundLeaf[] {
  return [...relayerRefundLeaves]
    .sort((leafA, leafB) => {
      if (leafA.chainId !== leafB.chainId) {
        return leafA.chainId - leafB.chainId;
      } else if (compareAddresses(leafA.l2TokenAddress, leafB.l2TokenAddress) !== 0) {
        return compareAddresses(leafA.l2TokenAddress, leafB.l2TokenAddress);
      } else if (leafA.groupIndex !== leafB.groupIndex) {
        return leafA.groupIndex - leafB.groupIndex;
      } else {
        throw new Error("Unexpected leaf group indices match");
      }
    })
    .map((leaf: RelayerRefundLeafWithGroup, i: number): RelayerRefundLeaf => {
      delete leaf.groupIndex; // Delete group index now that we've used it to sort leaves for the same
      // { repaymentChain, l2TokenAddress } since it doesn't exist in RelayerRefundLeaf
      return { ...leaf, leafId: i };
    });
}

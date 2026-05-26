import { Refund, RelayerRefundLeaf, RelayerRefundLeafWithGroup, SpokePoolTargetBalance } from "../interfaces";
import { BigNumber, bnZero, compareAddresses, getNetSendAmountForL1Token, Address, toAddressType } from "../utils";

export function getAmountToReturnForRelayerRefundLeaf(
  spokePoolTargetBalance: SpokePoolTargetBalance,
  runningBalanceForLeaf: BigNumber
): BigNumber {
  const netSendAmountForLeaf = getNetSendAmountForL1Token(spokePoolTargetBalance, runningBalanceForLeaf);
  return netSendAmountForLeaf.lt(bnZero) ? netSendAmountForLeaf.mul(-1) : bnZero;
}

export function sortRefundAddresses(refunds: Refund, chainId: number): Address[] {
  const deepCopy = { ...refunds };
  return [...Object.keys(deepCopy)]
    .sort((addressA, addressB) => {
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
    })
    .map((address) => toAddressType(address, chainId));
}

// Shared `{ message, mrkdwn }` for a relayer-refund-leaf execution log. Both EVM and SVM call
// this with the same args; pass `explorerLink` when the explorer link is known at log time (SVM
// has the signature in hand). EVM omits it and lets TransactionClient#submit append the
// parenthetical from the tx response in the same `<message> (<explorer>): <mrkdwn>` shape.
export function formatRelayerRefundLeafExecutionLog(args: {
  rootBundleId: number;
  relayerRefundRoot: string;
  leafId: number;
  chainId: number;
  symbol: string;
  amountToReturn: BigNumber;
  explorerLink?: string;
}): { message: string; mrkdwn: string } {
  const baseMessage = "Executed RelayerRefundLeaf 🌿!";
  return {
    message: args.explorerLink ? `${baseMessage} (${args.explorerLink})` : baseMessage,
    mrkdwn:
      `rootBundleId: ${args.rootBundleId}\n` +
      `relayerRefundRoot: ${args.relayerRefundRoot}\n` +
      `Leaf: ${args.leafId}\n` +
      `chainId: ${args.chainId}\n` +
      `token: ${args.symbol}\n` +
      `amount: ${args.amountToReturn.toString()}`,
  };
}

// Sort leaves by chain ID and then L2 token address in ascending order. Assign leaves unique, ascending ID's
// beginning from 0.
export function sortRelayerRefundLeaves(relayerRefundLeaves: RelayerRefundLeafWithGroup[]): RelayerRefundLeaf[] {
  return [...relayerRefundLeaves]
    .sort((leafA, leafB) => {
      if (leafA.chainId !== leafB.chainId) {
        return leafA.chainId - leafB.chainId;
      } else if (compareAddresses(leafA.l2TokenAddress.toBytes32(), leafB.l2TokenAddress.toBytes32()) !== 0) {
        return compareAddresses(leafA.l2TokenAddress.toBytes32(), leafB.l2TokenAddress.toBytes32());
      } else if (leafA.groupIndex !== leafB.groupIndex) {
        return leafA.groupIndex - leafB.groupIndex;
      } else {
        throw new Error("Unexpected leaf group indices match");
      }
    })
    .map((leaf: RelayerRefundLeafWithGroup, i: number): RelayerRefundLeaf => {
      // Drop groupIndex: only used for sorting within { repaymentChain, l2TokenAddress }; not part of RelayerRefundLeaf.
      const { groupIndex: _groupIndex, ...rest } = leaf;
      return { ...rest, leafId: i };
    });
}

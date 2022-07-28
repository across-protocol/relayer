import { BigNumberForToken, DepositWithBlock, FillsToRefund, FillWithBlock, PoolRebalanceLeaf } from "../interfaces";
import { RelayData, RelayerRefundLeaf } from "../interfaces";
import { RelayerRefundLeafWithGroup, RunningBalances, UnfilledDeposit } from "../interfaces";
import { buildPoolRebalanceLeafTree, buildRelayerRefundTree, buildSlowRelayTree, toBNWei, winston } from "../utils";
import { getDepositPath, getFillsInRange, groupObjectCountsByProp, groupObjectCountsByTwoProps, toBN } from "../utils";
import { DataworkerClients } from "./DataworkerClientHelper";
import { addSlowFillsToRunningBalances, initializeRunningBalancesFromRelayerRepayments } from "./PoolRebalanceUtils";
import { addLastRunningBalance, constructPoolRebalanceLeaves } from "./PoolRebalanceUtils";
import { updateRunningBalanceForDeposit } from "./PoolRebalanceUtils";
import { subtractExcessFromPreviousSlowFillsFromRunningBalances } from "./PoolRebalanceUtils";
import { getAmountToReturnForRelayerRefundLeaf } from "./RelayerRefundUtils";
import { sortRefundAddresses, sortRelayerRefundLeaves } from "./RelayerRefundUtils";

export function getEndBlockBuffers(
  chainIdListForBundleEvaluationBlockNumbers: number[],
  blockRangeEndBlockBuffer: { [chainId: number]: number }
): number[] {
  // These buffers can be configured by the bot runner. They have two use cases:
  // 1) Validate the end blocks specified in the pending root bundle. If the end block is greater than the latest
  // block for its chain, then we should dispute the bundle because we can't look up events in the future for that
  // chain. However, there are some cases where the proposer's node for that chain is returning a higher HEAD block
  // than the bot-runner is seeing, so we can use this buffer to allow the proposer some margin of error. If
  // the bundle end block is less than HEAD but within this buffer, then we won't dispute and we'll just exit
  // early from this function.
  // 2) Subtract from the latest block in a new root bundle proposal. This can be used to reduce the chance that
  // bot runs using different providers see different contract state close to the HEAD block for a chain.
  // Reducing the latest block that we query also gives partially filled deposits slightly more buffer for relayers
  // to fully fill the deposit and reduces the chance that the data worker includes a slow fill payment that gets
  // filled during the challenge period.
  return chainIdListForBundleEvaluationBlockNumbers.map((chainId: number) => blockRangeEndBlockBuffer[chainId] ?? 0);
}

export function getBlockRangeForChain(
  blockRange: number[][],
  chain: number,
  chainIdListForBundleEvaluationBlockNumbers: number[]
): number[] {
  const indexForChain = chainIdListForBundleEvaluationBlockNumbers.indexOf(chain);
  if (indexForChain === -1)
    throw new Error(
      `Could not find chain ${chain} in chain ID list ${this.chainIdListForBundleEvaluationBlockNumbers}`
    );
  const blockRangeForChain = blockRange[indexForChain];
  if (!blockRangeForChain || blockRangeForChain.length !== 2) throw new Error(`Invalid block range for chain ${chain}`);
  return blockRangeForChain;
}

export function prettyPrintSpokePoolEvents(
  blockRangesForChains: number[][],
  chainIdListForBundleEvaluationBlockNumbers: number[],
  deposits: DepositWithBlock[],
  allValidFills: FillWithBlock[],
  allRelayerRefunds: { repaymentChain: string; repaymentToken: string }[],
  unfilledDeposits: UnfilledDeposit[],
  allInvalidFills: FillWithBlock[]
) {
  const allInvalidFillsInRange = getFillsInRange(
    allInvalidFills,
    blockRangesForChains,
    chainIdListForBundleEvaluationBlockNumbers
  );
  const allValidFillsInRange = getFillsInRange(
    allValidFills,
    blockRangesForChains,
    chainIdListForBundleEvaluationBlockNumbers
  );
  return {
    depositsInRangeByOriginChain: groupObjectCountsByTwoProps(deposits, "originChainId", (deposit) =>
      getDepositPath(deposit)
    ),
    allValidFillsInRangeByDestinationChain: groupObjectCountsByTwoProps(
      allValidFillsInRange,
      "destinationChainId",
      (fill) => `${fill.originChainId}-->${fill.destinationToken}`
    ),
    fillsToRefundInRangeByRepaymentChain: groupObjectCountsByTwoProps(
      allRelayerRefunds,
      "repaymentChain",
      (repayment) => repayment.repaymentToken
    ),
    unfilledDepositsByDestinationChain: groupObjectCountsByProp(
      unfilledDeposits,
      (unfilledDeposit) => unfilledDeposit.deposit.destinationChainId
    ),
    allInvalidFillsInRangeByDestinationChain: groupObjectCountsByTwoProps(
      allInvalidFillsInRange,
      "destinationChainId",
      (fill) => `${fill.originChainId}-->${fill.destinationToken}`
    ),
  };
}

export function _buildSlowRelayRoot(unfilledDeposits: UnfilledDeposit[]) {
  const slowRelayLeaves: RelayData[] = unfilledDeposits.map(
    (deposit: UnfilledDeposit): RelayData => ({
      depositor: deposit.deposit.depositor,
      recipient: deposit.deposit.recipient,
      destinationToken: deposit.deposit.destinationToken,
      amount: deposit.deposit.amount,
      originChainId: deposit.deposit.originChainId,
      destinationChainId: deposit.deposit.destinationChainId,
      realizedLpFeePct: deposit.deposit.realizedLpFeePct,
      relayerFeePct: deposit.deposit.relayerFeePct,
      depositId: deposit.deposit.depositId,
    })
  );

  // Sort leaves deterministically so that the same root is always produced from the same _loadData return value.
  // The { Deposit ID, origin chain ID } is guaranteed to be unique so we can sort on them.
  const sortedLeaves = [...slowRelayLeaves].sort((relayA, relayB) => {
    // Note: Smaller ID numbers will come first
    if (relayA.originChainId === relayB.originChainId) return relayA.depositId - relayB.depositId;
    else return relayA.originChainId - relayB.originChainId;
  });

  return {
    leaves: sortedLeaves,
    tree: buildSlowRelayTree(sortedLeaves),
  };
}

export function _buildRelayerRefundRoot(
  endBlockForMainnet: number,
  fillsToRefund: FillsToRefund,
  poolRebalanceLeaves: PoolRebalanceLeaf[],
  runningBalances: RunningBalances,
  clients: DataworkerClients,
  maxRefundCount: number,
  tokenTransferThresholdOverrides: BigNumberForToken
) {
  const relayerRefundLeaves: RelayerRefundLeafWithGroup[] = [];

  // We'll construct a new leaf for each { repaymentChainId, L2TokenAddress } unique combination.
  Object.keys(fillsToRefund).forEach((repaymentChainId: string) => {
    Object.keys(fillsToRefund[repaymentChainId]).forEach((l2TokenAddress: string) => {
      const refunds = fillsToRefund[repaymentChainId][l2TokenAddress].refunds;
      if (refunds === undefined) return;

      // We need to sort leaves deterministically so that the same root is always produced from the same _loadData
      // return value, so sort refund addresses by refund amount (descending) and then address (ascending).
      const sortedRefundAddresses = sortRefundAddresses(refunds);

      // Create leaf for { repaymentChainId, L2TokenAddress }, split leaves into sub-leaves if there are too many
      // refunds.
      const l1TokenCounterpart = clients.hubPoolClient.getL1TokenCounterpartAtBlock(
        repaymentChainId,
        l2TokenAddress,
        endBlockForMainnet
      );
      const transferThreshold =
        tokenTransferThresholdOverrides[l1TokenCounterpart] ||
        clients.configStoreClient.getTokenTransferThresholdForBlock(l1TokenCounterpart, endBlockForMainnet);

      // The `amountToReturn` for a { repaymentChainId, L2TokenAddress} should be set to max(-netSendAmount, 0).
      const amountToReturn = getAmountToReturnForRelayerRefundLeaf(
        transferThreshold,
        runningBalances[repaymentChainId][l1TokenCounterpart]
      );
      for (let i = 0; i < sortedRefundAddresses.length; i += maxRefundCount)
        relayerRefundLeaves.push({
          groupIndex: i, // Will delete this group index after using it to sort leaves for the same chain ID and
          // L2 token address
          amountToReturn: i === 0 ? amountToReturn : toBN(0),
          chainId: Number(repaymentChainId),
          refundAmounts: sortedRefundAddresses.slice(i, i + maxRefundCount).map((address) => refunds[address]),
          leafId: 0, // Will be updated before inserting into tree when we sort all leaves.
          l2TokenAddress,
          refundAddresses: sortedRefundAddresses.slice(i, i + maxRefundCount),
        });
    });
  });

  // We need to construct a leaf for any pool rebalance leaves with a negative net send amount and NO fills to refund
  // since we need to return tokens from SpokePool to HubPool.
  poolRebalanceLeaves.forEach((leaf) => {
    leaf.netSendAmounts.forEach((netSendAmount, index) => {
      if (netSendAmount.gte(toBN(0))) return;

      const l2TokenCounterpart = clients.hubPoolClient.getDestinationTokenForL1Token(
        leaf.l1Tokens[index],
        leaf.chainId
      );
      // If we've already seen this leaf, then skip.
      if (
        relayerRefundLeaves.some(
          (relayerRefundLeaf) =>
            relayerRefundLeaf.chainId === leaf.chainId && relayerRefundLeaf.l2TokenAddress === l2TokenCounterpart
        )
      )
        return;
      const transferThreshold =
        tokenTransferThresholdOverrides[leaf.l1Tokens[index]] ||
        clients.configStoreClient.getTokenTransferThresholdForBlock(leaf.l1Tokens[index], endBlockForMainnet);
      const amountToReturn = getAmountToReturnForRelayerRefundLeaf(
        transferThreshold,
        runningBalances[leaf.chainId][leaf.l1Tokens[index]]
      );
      relayerRefundLeaves.push({
        groupIndex: 0, // Will delete this group index after using it to sort leaves for the same chain ID and
        // L2 token address
        leafId: 0, // Will be updated before inserting into tree when we sort all leaves.
        chainId: leaf.chainId,
        amountToReturn: amountToReturn, // Never 0 since there will only be one leaf for this chain + L2 token combo.
        l2TokenAddress: l2TokenCounterpart,
        refundAddresses: [],
        refundAmounts: [],
      });
    });
  });

  const indexedLeaves: RelayerRefundLeaf[] = sortRelayerRefundLeaves(relayerRefundLeaves);
  return {
    leaves: indexedLeaves,
    tree: buildRelayerRefundTree(indexedLeaves),
  };
}

export function _buildPoolRebalanceRoot(
  mainnetBundleEndBlock: number,
  fillsToRefund: FillsToRefund,
  deposits: DepositWithBlock[],
  allValidFills: FillWithBlock[],
  allValidFillsInRange: FillWithBlock[],
  unfilledDeposits: UnfilledDeposit[],
  clients: DataworkerClients,
  chainIdListForBundleEvaluationBlockNumbers: number[],
  maxL1TokenCountOverride: number,
  tokenTransferThreshold: BigNumberForToken,
  logger?: winston.Logger
) {
  // Running balances are the amount of tokens that we need to send to each SpokePool to pay for all instant and
  // slow relay refunds. They are decreased by the amount of funds already held by the SpokePool. Balances are keyed
  // by the SpokePool's network and L1 token equivalent of the L2 token to refund.
  // Realized LP fees are keyed the same as running balances and represent the amount of LP fees that should be paid
  // to LP's for each running balance.

  // For each FilledRelay group, identified by { repaymentChainId, L1TokenAddress }, initialize a "running balance"
  // to the total refund amount for that group.
  const runningBalances: RunningBalances = {};
  const realizedLpFees: RunningBalances = {};
  initializeRunningBalancesFromRelayerRepayments(
    runningBalances,
    realizedLpFees,
    mainnetBundleEndBlock,
    clients.hubPoolClient,
    fillsToRefund
  );

  // Add payments to execute slow fills.
  addSlowFillsToRunningBalances(mainnetBundleEndBlock, runningBalances, clients.hubPoolClient, unfilledDeposits);

  // For certain fills associated with another partial fill from a previous root bundle, we need to adjust running
  // balances because the prior partial fill would have triggered a refund to be sent to the spoke pool to refund
  // a slow fill.
  const fillsTriggeringExcesses = subtractExcessFromPreviousSlowFillsFromRunningBalances(
    clients.hubPoolClient.latestBlockNumber,
    runningBalances,
    clients.hubPoolClient,
    allValidFills,
    allValidFillsInRange,
    chainIdListForBundleEvaluationBlockNumbers
  );
  if (logger)
    logger.debug({
      at: "Dataworker#DataworkerUtils",
      message: "Fills triggering excess returns from L2",
      fillsTriggeringExcesses,
    });

  // Map each deposit event to its L1 token and origin chain ID and subtract deposited amounts from running
  // balances. Note that we do not care if the deposit is matched with a fill for this epoch or not since all
  // deposit events lock funds in the spoke pool and should decrease running balances accordingly. However,
  // its important that `deposits` are all in this current block range.
  deposits.forEach((deposit: DepositWithBlock) => {
    updateRunningBalanceForDeposit(runningBalances, clients.hubPoolClient, deposit, deposit.amount.mul(toBN(-1)));
  });

  // Add to the running balance value from the last valid root bundle proposal for {chainId, l1Token}
  // combination if found.
  addLastRunningBalance(mainnetBundleEndBlock, runningBalances, clients.hubPoolClient);

  const leaves: PoolRebalanceLeaf[] = constructPoolRebalanceLeaves(
    mainnetBundleEndBlock,
    runningBalances,
    realizedLpFees,
    clients.configStoreClient,
    maxL1TokenCountOverride,
    tokenTransferThreshold
  );

  return {
    runningBalances,
    realizedLpFees,
    leaves,
    tree: buildPoolRebalanceLeafTree(leaves),
  };
}

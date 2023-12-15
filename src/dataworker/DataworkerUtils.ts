import { utils, typechain } from "@across-protocol/sdk-v2";
import { SpokePoolClient } from "../clients";
import { spokesThatHoldEthAndWeth } from "../common/Constants";
import { CONTRACT_ADDRESSES } from "../common/ContractAddresses";
import {
  DepositWithBlock,
  FillsToRefund,
  FillWithBlock,
  PoolRebalanceLeaf,
  RelayerRefundLeaf,
  RelayerRefundLeafWithGroup,
  RunningBalances,
  SlowFillLeaf,
  SpokePoolClientsByChain,
  UnfilledDeposit,
} from "../interfaces";
import {
  AnyObject,
  bnZero,
  buildPoolRebalanceLeafTree,
  buildRelayerRefundTree,
  buildSlowRelayTree,
  getDepositPath,
  getFillsInRange,
  groupObjectCountsByProp,
  groupObjectCountsByTwoProps,
  isDefined,
  MerkleTree,
  winston,
} from "../utils";
import { PoolRebalanceRoot } from "./Dataworker";
import { DataworkerClients } from "./DataworkerClientHelper";
import {
  addLastRunningBalance,
  addSlowFillsToRunningBalances,
  constructPoolRebalanceLeaves,
  initializeRunningBalancesFromRelayerRepayments,
  subtractExcessFromPreviousSlowFillsFromRunningBalances,
  updateRunningBalanceForDeposit,
  updateRunningBalanceForEarlyDeposit,
} from "./PoolRebalanceUtils";
import {
  getAmountToReturnForRelayerRefundLeaf,
  sortRefundAddresses,
  sortRelayerRefundLeaves,
} from "./RelayerRefundUtils";
export const { getImpliedBundleBlockRanges, getBlockRangeForChain, getBlockForChain } = utils;

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

// Return true if we won't be able to construct a root bundle for the bundle block ranges ("blockRanges") because
// the bundle wants to look up data for events that weren't in the spoke pool client's search range.
export function blockRangesAreInvalidForSpokeClients(
  spokePoolClients: Record<number, SpokePoolClient>,
  blockRanges: number[][],
  chainIdListForBundleEvaluationBlockNumbers: number[],
  latestInvalidBundleStartBlock: { [chainId: number]: number }
): boolean {
  return blockRanges.some(([start, end], index) => {
    const chainId = chainIdListForBundleEvaluationBlockNumbers[index];
    // If block range is 0 then chain is disabled, we don't need to query events for this chain.
    if (isNaN(end) || isNaN(start)) {
      return true;
    }
    if (start === end) {
      return false;
    }

    // If spoke pool client doesn't exist for enabled chain then we clearly cannot query events for this chain.
    if (spokePoolClients[chainId] === undefined) {
      return true;
    }

    const clientLastBlockQueried =
      spokePoolClients[chainId].eventSearchConfig.toBlock ?? spokePoolClients[chainId].latestBlockNumber;

    // Note: Math.max the from block with the deployment block of the spoke pool to handle the edge case for the first
    // bundle that set its start blocks equal 0.
    const bundleRangeFromBlock = Math.max(spokePoolClients[chainId].deploymentBlock, start);
    return bundleRangeFromBlock <= latestInvalidBundleStartBlock[chainId] || end > clientLastBlockQueried;
  });
}

export function prettyPrintSpokePoolEvents(
  blockRangesForChains: number[][],
  chainIdListForBundleEvaluationBlockNumbers: number[],
  deposits: DepositWithBlock[],
  allValidFills: FillWithBlock[],
  allRelayerRefunds: { repaymentChain: number; repaymentToken: string }[],
  unfilledDeposits: UnfilledDeposit[],
  allInvalidFills: FillWithBlock[]
): AnyObject {
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

export function _buildSlowRelayRoot(unfilledDeposits: UnfilledDeposit[]): {
  leaves: SlowFillLeaf[];
  tree: MerkleTree<SlowFillLeaf>;
} {
  const slowRelayLeaves: SlowFillLeaf[] = unfilledDeposits.map(
    (deposit: UnfilledDeposit): SlowFillLeaf => ({
      relayData: {
        depositor: deposit.deposit.depositor,
        recipient: deposit.deposit.recipient,
        destinationToken: deposit.deposit.destinationToken,
        amount: deposit.deposit.amount,
        originChainId: deposit.deposit.originChainId,
        destinationChainId: deposit.deposit.destinationChainId,
        realizedLpFeePct: deposit.deposit.realizedLpFeePct,
        relayerFeePct: deposit.deposit.relayerFeePct,
        depositId: deposit.deposit.depositId,
        message: deposit.deposit.message,
      },
      payoutAdjustmentPct: deposit?.relayerBalancingFee?.toString() ?? "0",
    })
  );

  // Sort leaves deterministically so that the same root is always produced from the same _loadData return value.
  // The { Deposit ID, origin chain ID } is guaranteed to be unique so we can sort on them.
  const sortedLeaves = [...slowRelayLeaves].sort((relayA, relayB) => {
    // Note: Smaller ID numbers will come first
    if (relayA.relayData.originChainId === relayB.relayData.originChainId) {
      return relayA.relayData.depositId - relayB.relayData.depositId;
    } else {
      return relayA.relayData.originChainId - relayB.relayData.originChainId;
    }
  });

  return {
    leaves: sortedLeaves,
    tree: buildSlowRelayTree(sortedLeaves),
  };
}

// @dev `runningBalances` is only used in pre-UBA model to determine whether a spoke's running balances
// are over the target/threshold. In the UBA model, this is handled at the UBA client level.
export function _buildRelayerRefundRoot(
  endBlockForMainnet: number,
  fillsToRefund: FillsToRefund,
  poolRebalanceLeaves: PoolRebalanceLeaf[],
  runningBalances: RunningBalances,
  clients: DataworkerClients,
  maxRefundCount: number,
  isUBA = false
): {
  leaves: RelayerRefundLeaf[];
  tree: MerkleTree<RelayerRefundLeaf>;
} {
  const relayerRefundLeaves: RelayerRefundLeafWithGroup[] = [];

  // We'll construct a new leaf for each { repaymentChainId, L2TokenAddress } unique combination.
  Object.entries(fillsToRefund).forEach(([_repaymentChainId, fillsForChain]) => {
    const repaymentChainId = Number(_repaymentChainId);
    Object.entries(fillsForChain).forEach(([l2TokenAddress, fillsForToken]) => {
      const refunds = fillsForToken.refunds;
      if (refunds === undefined) {
        return;
      }

      // We need to sort leaves deterministically so that the same root is always produced from the same _loadData
      // return value, so sort refund addresses by refund amount (descending) and then address (ascending).
      const sortedRefundAddresses = sortRefundAddresses(refunds);

      // Create leaf for { repaymentChainId, L2TokenAddress }, split leaves into sub-leaves if there are too many
      // refunds.

      // If UBA model, set amount to return to 0 for now until we match this leaf against a pool rebalance leaf. In
      // the UBA model, the amount to return is simpler to compute: simply set it equal to the negative
      // net send amount value if the net send amount is negative.
      let amountToReturn = bnZero;
      if (!isUBA) {
        const l1TokenCounterpart = clients.hubPoolClient.getL1TokenForL2TokenAtBlock(
          l2TokenAddress,
          repaymentChainId,
          endBlockForMainnet
        );

        const spokePoolTargetBalance = clients.configStoreClient.getSpokeTargetBalancesForBlock(
          l1TokenCounterpart,
          Number(repaymentChainId),
          endBlockForMainnet
        );

        // The `amountToReturn` for a { repaymentChainId, L2TokenAddress} should be set to max(-netSendAmount, 0).
        amountToReturn = getAmountToReturnForRelayerRefundLeaf(
          spokePoolTargetBalance,
          runningBalances[repaymentChainId][l1TokenCounterpart]
        );
      }
      for (let i = 0; i < sortedRefundAddresses.length; i += maxRefundCount) {
        relayerRefundLeaves.push({
          groupIndex: i, // Will delete this group index after using it to sort leaves for the same chain ID and
          // L2 token address
          amountToReturn: i === 0 ? amountToReturn : bnZero,
          chainId: Number(repaymentChainId),
          refundAmounts: sortedRefundAddresses.slice(i, i + maxRefundCount).map((address) => refunds[address]),
          leafId: 0, // Will be updated before inserting into tree when we sort all leaves.
          l2TokenAddress,
          refundAddresses: sortedRefundAddresses.slice(i, i + maxRefundCount),
        });
      }
    });
  });

  // We need to construct a leaf for any pool rebalance leaves with a negative net send amount and NO fills to refund
  // since we need to return tokens from SpokePool to HubPool.
  poolRebalanceLeaves.forEach((leaf) => {
    leaf.netSendAmounts.forEach((netSendAmount, index) => {
      if (netSendAmount.gte(bnZero)) {
        return;
      }

      const l2TokenCounterpart = clients.hubPoolClient.getL2TokenForL1TokenAtBlock(leaf.l1Tokens[index], leaf.chainId);
      // If we've already seen this leaf, then skip. If UBA, reset the net send amount and then skip.
      const existingLeaf = relayerRefundLeaves.find(
        (relayerRefundLeaf) =>
          relayerRefundLeaf.chainId === leaf.chainId && relayerRefundLeaf.l2TokenAddress === l2TokenCounterpart
      );
      if (existingLeaf !== undefined) {
        if (isUBA) {
          existingLeaf.amountToReturn = netSendAmount.mul(-1);
        }
        return;
      }

      // If UBA model we don't need to do the following to figure out the amount to return:
      let amountToReturn = netSendAmount.mul(-1);
      if (!isUBA) {
        const spokePoolTargetBalance = clients.configStoreClient.getSpokeTargetBalancesForBlock(
          leaf.l1Tokens[index],
          leaf.chainId,
          endBlockForMainnet
        );

        amountToReturn = getAmountToReturnForRelayerRefundLeaf(
          spokePoolTargetBalance,
          runningBalances[leaf.chainId][leaf.l1Tokens[index]]
        );
      }
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

export async function _buildPoolRebalanceRoot(
  latestMainnetBlock: number,
  mainnetBundleEndBlock: number,
  fillsToRefund: FillsToRefund,
  deposits: DepositWithBlock[],
  allValidFills: FillWithBlock[],
  allValidFillsInRange: FillWithBlock[],
  unfilledDeposits: UnfilledDeposit[],
  earlyDeposits: typechain.FundsDepositedEvent[],
  clients: DataworkerClients,
  spokePoolClients: SpokePoolClientsByChain,
  chainIdListForBundleEvaluationBlockNumbers: number[],
  maxL1TokenCountOverride: number | undefined,
  logger?: winston.Logger
): Promise<PoolRebalanceRoot> {
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
  const fillsTriggeringExcesses = await subtractExcessFromPreviousSlowFillsFromRunningBalances(
    mainnetBundleEndBlock,
    runningBalances,
    clients.hubPoolClient,
    spokePoolClients,
    allValidFills,
    allValidFillsInRange
  );

  if (logger && Object.keys(fillsTriggeringExcesses).length > 0) {
    logger.debug({
      at: "Dataworker#DataworkerUtils",
      message: "Fills triggering excess returns from L2",
      fillsTriggeringExcesses,
    });
  }

  // Map each deposit event to its L1 token and origin chain ID and subtract deposited amounts from running
  // balances. Note that we do not care if the deposit is matched with a fill for this epoch or not since all
  // deposit events lock funds in the spoke pool and should decrease running balances accordingly. However,
  // its important that `deposits` are all in this current block range.
  deposits.forEach((deposit: DepositWithBlock) => {
    updateRunningBalanceForDeposit(runningBalances, clients.hubPoolClient, deposit, deposit.amount.mul(-1));
  });

  earlyDeposits.forEach((earlyDeposit) => {
    updateRunningBalanceForEarlyDeposit(
      runningBalances,
      clients.hubPoolClient,
      earlyDeposit,
      // TODO: fix this.
      // Because cloneDeep drops the non-array elements of args, we have to use the index rather than the name.
      // As a fix, earlyDeposits should be treated similarly to other events and transformed at ingestion time
      // into a type that is more digestable rather than a raw event.
      earlyDeposit.args[0].mul(-1)
    );
  });

  // Add to the running balance value from the last valid root bundle proposal for {chainId, l1Token}
  // combination if found.
  addLastRunningBalance(latestMainnetBlock, runningBalances, clients.hubPoolClient);

  const leaves: PoolRebalanceLeaf[] = constructPoolRebalanceLeaves(
    mainnetBundleEndBlock,
    runningBalances,
    realizedLpFees,
    clients.configStoreClient,
    maxL1TokenCountOverride
  );

  return {
    runningBalances,
    realizedLpFees,
    leaves,
    tree: buildPoolRebalanceLeafTree(leaves),
  };
}

/**
 * @notice Returns WETH and ETH token addresses for chain if defined, or throws an error if they're not
 * in the hardcoded dictionary.
 * @param chainId chain to check for WETH and ETH addresses
 * @returns WETH and ETH addresses.
 */
function getWethAndEth(chainId): string[] {
  const wethAndEth = [CONTRACT_ADDRESSES[chainId].weth.address, CONTRACT_ADDRESSES[chainId].eth.address];
  if (wethAndEth.some((tokenAddress) => !isDefined(tokenAddress))) {
    throw new Error(`WETH or ETH address not defined for chain ${chainId}`);
  }
  return wethAndEth;
}
/**
 * @notice Some SpokePools will contain balances of ETH and WETH, while others will only contain balances of WETH,
 * so if the l2TokenAddress is WETH and the SpokePool is one such chain that holds both ETH and WETH,
 * then it should return both ETH and WETH. For other chains, it should only return the l2TokenAddress.
 * @param l2TokenAddress L2 token address in spoke leaf that we want to get addresses to check spoke balances for
 * @param l2ChainId L2 chain of Spoke
 * @returns Tokens that we should check the SpokePool balance for in order to execute a spoke leaf for
 * `l2TokenAddress` on `l2ChainId`.
 */
export function l2TokensToCountTowardsSpokePoolLeafExecutionCapital(
  l2TokenAddress: string,
  l2ChainId: number
): string[] {
  if (!spokesThatHoldEthAndWeth.includes(l2ChainId)) {
    return [l2TokenAddress];
  }
  // If we get to here, ETH and WETH addresses should be defined, or we'll throw an error.
  const ethAndWeth = getWethAndEth(l2ChainId);
  return ethAndWeth.includes(l2TokenAddress) ? ethAndWeth : [l2TokenAddress];
}

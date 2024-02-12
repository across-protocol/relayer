import assert from "assert";
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
  V2DepositWithBlock,
  V2FillWithBlock,
  V2SlowFillLeaf,
  V3FillWithBlock,
} from "../interfaces";
import {
  AnyObject,
  bnZero,
  buildPoolRebalanceLeafTree,
  buildRelayerRefundTree,
  buildSlowRelayTree,
  count2DDictionaryValues,
  count3DDictionaryValues,
  FillsRefundedData,
  FillsRefundedStatusEnum,
  getDepositPath,
  getFillsInRange,
  getTimestampsForBundleEndBlocks,
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
import {
  BundleDepositsV3,
  BundleExcessSlowFills,
  BundleFillsV3,
  BundleSlowFills,
  ExpiredDepositsToRefundV3,
} from "../interfaces/BundleData";
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

// TODO: Move to SDK-v2 since this implements UMIP logic about validating block ranges.
// Return true if we won't be able to construct a root bundle for the bundle block ranges ("blockRanges") because
// the bundle wants to look up data for events that weren't in the spoke pool client's search range.
export function blockRangesAreInvalidForSpokeClients(
  spokePoolClients: Record<number, SpokePoolClient>,
  blockRanges: number[][],
  chainIdListForBundleEvaluationBlockNumbers: number[],
  latestInvalidBundleStartBlock: { [chainId: number]: number },
  isV3 = false
): Promise<boolean> {
  return utils.someAsync(blockRanges, async ([start, end], index) => {
    const chainId = chainIdListForBundleEvaluationBlockNumbers[index];
    // If block range is 0 then chain is disabled, we don't need to query events for this chain.
    if (isNaN(end) || isNaN(start)) {
      return true;
    }
    if (start === end) {
      return false;
    }

    const spokePoolClient = spokePoolClients[chainId];

    // If spoke pool client doesn't exist for enabled chain then we clearly cannot query events for this chain.
    if (spokePoolClient === undefined) {
      return true;
    }

    const clientLastBlockQueried = spokePoolClient.latestBlockSearched;

    // If range start block is less than the earliest spoke pool client we can validate or the range end block
    // is greater than the latest client end block, then ranges are invalid.
    // Note: Math.max the from block with the deployment block of the spoke pool to handle the edge case for the first
    // bundle that set its start blocks equal 0.
    const bundleRangeFromBlock = Math.max(spokePoolClient.deploymentBlock, start);
    if (bundleRangeFromBlock <= latestInvalidBundleStartBlock[chainId] || end > clientLastBlockQueried) {
      return true;
    }

    if (isV3) {
      const endBlockTimestamps = await getTimestampsForBundleEndBlocks(
        spokePoolClients,
        blockRanges,
        chainIdListForBundleEvaluationBlockNumbers
      );
      const maxFillDeadlineBufferInBlockRange = await spokePoolClient.getMaxFillDeadlineInRange(start, end);
      if (endBlockTimestamps[chainId] - spokePoolClient.getOldestTime() < maxFillDeadlineBufferInBlockRange) {
        return true;
      }
    }
    // We must now assume that all newly expired deposits at the time of the bundle end blocks are contained within
    // the spoke pool client's memory.

    // If we get to here, block ranges are valid, return false.
    return false;
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
      (fill) => `${fill.originChainId}-->${utils.getFillOutputToken(fill)}`
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
      (fill) => `${fill.originChainId}-->${utils.getFillOutputToken(fill)}`
    ),
  };
}

export function prettyPrintV3SpokePoolEvents(
  bundleDepositsV3: BundleDepositsV3,
  bundleFillsV3: BundleFillsV3,
  bundleInvalidFillsV3: V3FillWithBlock[],
  bundleSlowFillsV3: BundleSlowFills,
  expiredDepositsToRefundV3: ExpiredDepositsToRefundV3,
  unexecutableSlowFills: BundleExcessSlowFills
): AnyObject {
  return {
    bundleDepositsV3: count2DDictionaryValues(bundleDepositsV3),
    bundleFillsV3: count3DDictionaryValues(bundleFillsV3, "fills"),
    bundleSlowFillsV3: count2DDictionaryValues(bundleSlowFillsV3),
    expiredDepositsToRefundV3: count2DDictionaryValues(expiredDepositsToRefundV3),
    unexecutableSlowFills: count2DDictionaryValues(unexecutableSlowFills),
    allInvalidFillsInRangeByDestinationChainAndRelayer: groupObjectCountsByTwoProps(
      bundleInvalidFillsV3,
      "destinationChainId",
      (fill) => `${fill.relayer}`
    ),
  };
}

export function _buildSlowRelayRoot(unfilledDeposits: UnfilledDeposit[]): {
  leaves: SlowFillLeaf[];
  tree: MerkleTree<SlowFillLeaf>;
} {
  const slowRelayLeaves: SlowFillLeaf[] = unfilledDeposits.map((deposit: UnfilledDeposit) =>
    buildV2SlowFillLeaf(deposit)
  );

  // Sort leaves deterministically so that the same root is always produced from the same loadData return value.
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

function buildV2SlowFillLeaf(unfilledDeposit: UnfilledDeposit): V2SlowFillLeaf {
  const { deposit } = unfilledDeposit;
  assert(utils.isV2Deposit(deposit));

  return {
    relayData: {
      depositor: deposit.depositor,
      recipient: deposit.recipient,
      destinationToken: deposit.destinationToken,
      amount: deposit.amount,
      originChainId: deposit.originChainId,
      destinationChainId: deposit.destinationChainId,
      realizedLpFeePct: deposit.realizedLpFeePct,
      relayerFeePct: deposit.relayerFeePct,
      depositId: deposit.depositId,
      message: deposit.message,
    },
    payoutAdjustmentPct: unfilledDeposit.relayerBalancingFee?.toString() ?? "0",
  };
}

export function _buildRelayerRefundRoot(
  endBlockForMainnet: number,
  fillsToRefund: FillsToRefund,
  poolRebalanceLeaves: PoolRebalanceLeaf[],
  runningBalances: RunningBalances,
  clients: DataworkerClients,
  maxRefundCount: number
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

      // We need to sort leaves deterministically so that the same root is always produced from the same loadData
      // return value, so sort refund addresses by refund amount (descending) and then address (ascending).
      const sortedRefundAddresses = sortRefundAddresses(refunds);

      const l1TokenCounterpart = clients.hubPoolClient.getL1TokenForL2TokenAtBlock(
        l2TokenAddress,
        repaymentChainId,
        endBlockForMainnet
      );

      const spokePoolTargetBalance = clients.configStoreClient.getSpokeTargetBalancesForBlock(
        l1TokenCounterpart,
        repaymentChainId,
        endBlockForMainnet
      );

      // The `amountToReturn` for a { repaymentChainId, L2TokenAddress} should be set to max(-netSendAmount, 0).
      const amountToReturn = getAmountToReturnForRelayerRefundLeaf(
        spokePoolTargetBalance,
        runningBalances[repaymentChainId][l1TokenCounterpart]
      );

      // Create leaf for { repaymentChainId, L2TokenAddress }, split leaves into sub-leaves if there are too many
      // refunds.
      for (let i = 0; i < sortedRefundAddresses.length; i += maxRefundCount) {
        relayerRefundLeaves.push({
          groupIndex: i, // Will delete this group index after using it to sort leaves for the same chain ID and
          // L2 token address
          amountToReturn: i === 0 ? amountToReturn : bnZero,
          chainId: repaymentChainId,
          refundAmounts: sortedRefundAddresses.slice(i, i + maxRefundCount).map((address) => refunds[address]),
          leafId: 0, // Will be updated before inserting into tree when we sort all leaves.
          l2TokenAddress,
          refundAddresses: sortedRefundAddresses.slice(i, i + maxRefundCount),
        });
      }
    });
  });

  // TODO: Add v3 expired deposits to relayer refund leaf.

  // We need to construct a leaf for any pool rebalance leaves with a negative net send amount and NO fills to refund
  // since we need to return tokens from SpokePool to HubPool.
  poolRebalanceLeaves.forEach((leaf) => {
    leaf.netSendAmounts.forEach((netSendAmount, index) => {
      if (netSendAmount.gte(bnZero)) {
        return;
      }

      const l2TokenCounterpart = clients.hubPoolClient.getL2TokenForL1TokenAtBlock(leaf.l1Tokens[index], leaf.chainId);
      // If we've already seen this leaf, then skip.
      const existingLeaf = relayerRefundLeaves.find(
        (relayerRefundLeaf) =>
          relayerRefundLeaf.chainId === leaf.chainId && relayerRefundLeaf.l2TokenAddress === l2TokenCounterpart
      );
      if (existingLeaf !== undefined) {
        return;
      }

      const spokePoolTargetBalance = clients.configStoreClient.getSpokeTargetBalancesForBlock(
        leaf.l1Tokens[index],
        leaf.chainId,
        endBlockForMainnet
      );

      const amountToReturn = getAmountToReturnForRelayerRefundLeaf(
        spokePoolTargetBalance,
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

export async function _buildPoolRebalanceRoot(
  latestMainnetBlock: number,
  mainnetBundleEndBlock: number,
  fillsToRefund: FillsToRefund,
  deposits: V2DepositWithBlock[],
  allValidFills: V2FillWithBlock[],
  allValidFillsInRange: V2FillWithBlock[],
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

  /**
   * REFUNDS FOR FAST FILLS
   */

  initializeRunningBalancesFromRelayerRepayments(
    runningBalances,
    realizedLpFees,
    mainnetBundleEndBlock,
    clients.hubPoolClient,
    fillsToRefund
  );

  // TODO: Add running balances and lp fees for v3 relayer refunds using BundleDataClient.bundleFillsV3. Refunds
  // should be equal to inputAmount - lpFees so that relayers get to keep the relayer fee. Add the refund amount
  // to the running balance for the repayment chain.

  /**
   * PAYMENTS SLOW FILLS
   */

  // Add payments to execute slow fills.
  addSlowFillsToRunningBalances(mainnetBundleEndBlock, runningBalances, clients.hubPoolClient, unfilledDeposits);

  // TODO: Add running balances and lp fees for v3 slow fills using BundleDataClient.bundleSlowFillsV3.
  // Slow fills should still increment bundleLpFees and updatedOutputAmount should be equal to inputAmount - lpFees.
  // Increment the updatedOutputAmount to the destination chain.

  /**
   * EXCESSES FROM UNEXECUTABLE SLOW FILLS
   */

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

  // TODO: Subtract running balances from BundleDataClient.unexecutableSlowFills. These are all slow fills that
  // failed to execute therefore the amount to return would be the updatedOutputAmount = inputAmount - lpFees.
  // Decrement the excess amounts from the destination chain running baalnce.

  if (logger && Object.keys(fillsTriggeringExcesses).length > 0) {
    logger.debug({
      at: "Dataworker#DataworkerUtils",
      message: "Fills triggering excess returns from L2",
      fillsTriggeringExcesses,
    });
  }

  /**
   * DEPOSITS
   */

  // Map each deposit event to its L1 token and origin chain ID and subtract deposited amounts from running
  // balances. Note that we do not care if the deposit is matched with a fill for this epoch or not since all
  // deposit events lock funds in the spoke pool and should decrease running balances accordingly. However,
  // its important that `deposits` are all in this current block range.
  deposits.forEach((deposit: V2DepositWithBlock) => {
    const inputAmount = utils.getDepositInputAmount(deposit);
    updateRunningBalanceForDeposit(runningBalances, clients.hubPoolClient, deposit, inputAmount.mul(-1));
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

  // TODO: Handle v3Deposits. These decrement running balances from the origin chain equal to the inputAmount.
  // There should not be early deposits in v3.

  /**
   * REFUNDS FOR EXPIRED DEPOSITS
   */

  // TODO: Add expired v3 deposits. These should refund the inputAmount and increment running balances to the
  // origin chain equal to the inputAmount.

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
 * @notice Returns all of the fills to refund, slow fills, and expired deposits
 * in a root bundle. This is designed to be used by the dataworker when proposing a root bundle to post
 * as proof for their root bundle.
 * @dev This function can be used to construct data to post to a persistent storage layer (e.g. Arweave/IPFS) that
 * can be used to construct a proposed SlowRelayRoot and RelayerRefundRoot.
 * For example, this file should contain the expired deposits and fills to be refunded in this leaf along with all
 * other leaves from the same relayer refund root bundle and all slow fills from the same root bundle ID.
 *  Note that this data does not contain all of the data needed to produce the root bundle's poolRebalanceRoot
 * because it doesn't contain deposits and unexecutable slow fills. However, the goal of the data posted here is
 * to support real-time status tracking deposits, for which the fills, expired deposits, and slow fills in this
 * bundle are sufficient.
 * @dev The params are easily retrieved by calling BundleDataClient.loadData
 */
export function buildFillsRefundedDictionary(
  bundleFillsV3: BundleFillsV3,
  expiredDepositsToRefundV3: ExpiredDepositsToRefundV3,
  bundleSlowFillsV3: BundleSlowFills
): FillsRefundedData {
  const dictionary: FillsRefundedData = {};
  // Each relayDataHash should contain a fill, a slow fill creation, or an expired deposit.
  // There shouldn't be more than one of these types in a single bundle, otherwise
  // the bundle data client should have thrown an error.

  Object.entries(bundleFillsV3).forEach(([, dataForToken]) => {
    Object.entries(dataForToken).forEach(([, { fills }]) => {
      fills.forEach((fill) => {
        const relayDataHash = utils.getV3RelayHashFromEvent(fill);
        assert(
          !dictionary[relayDataHash],
          "Duplicate relayDataHash in FillsRefundedEntry found when searching bundleFillsV3"
        );
        dictionary[relayDataHash] = {
          status: FillsRefundedStatusEnum.Filled,
          repaymentChainId: fill.repaymentChainId,
          relayer: fill.relayer,
          relayExecutionInfo: fill.relayExecutionInfo,
          lpFeePct: fill.lpFeePct,
        };
      });
    });
  });

  Object.entries(expiredDepositsToRefundV3).forEach(([, dataForToken]) => {
    Object.entries(dataForToken).forEach(([, deposits]) => {
      deposits.forEach((deposit) => {
        const relayDataHash = utils.getV3RelayHashFromEvent(deposit);
        assert(
          !dictionary[relayDataHash],
          "Duplicate relayDataHash in FillsRefundedEntry found when searching expiredDepositsToRefundV3"
        );
        dictionary[relayDataHash] = {
          status: FillsRefundedStatusEnum.Expired,
        };
      });
    });
  });

  Object.entries(bundleSlowFillsV3).forEach(([, dataForToken]) => {
    Object.entries(dataForToken).forEach(([, deposits]) => {
      deposits.forEach((depositToSlowFill) => {
        const relayDataHash = utils.getV3RelayHashFromEvent(depositToSlowFill);
        assert(
          !dictionary[relayDataHash],
          "Duplicate relayDataHash in FillsRefundedEntry found when searching bundleSlowFillsV3"
        );
        dictionary[relayDataHash] = {
          status: FillsRefundedStatusEnum.CreatedSlowFill,
          lpFeePct: depositToSlowFill.realizedLpFeePct,
        };
      });
    });
  });

  return dictionary;
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

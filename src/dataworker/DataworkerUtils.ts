import assert from "assert";
import { utils, interfaces, caching } from "@across-protocol/sdk";
import { SpokePoolClient } from "../clients";
import {
  ARWEAVE_TAG_BYTE_LIMIT,
  CONSERVATIVE_BUNDLE_FREQUENCY_SECONDS,
  spokesThatHoldEthAndWeth,
} from "../common/Constants";
import { CONTRACT_ADDRESSES } from "../common/ContractAddresses";
import {
  PoolRebalanceLeaf,
  Refund,
  RelayerRefundLeaf,
  RelayerRefundLeafWithGroup,
  RunningBalances,
  SlowFillLeaf,
} from "../interfaces";
import {
  BigNumber,
  bnZero,
  buildRelayerRefundTree,
  buildSlowRelayTree,
  fixedPointAdjustment,
  getRefundsFromBundle,
  getTimestampsForBundleEndBlocks,
  isDefined,
  MerkleTree,
  Profiler,
  TOKEN_SYMBOLS_MAP,
  winston,
} from "../utils";
import { DataworkerClients } from "./DataworkerClientHelper";
import {
  getAmountToReturnForRelayerRefundLeaf,
  sortRefundAddresses,
  sortRelayerRefundLeaves,
} from "./RelayerRefundUtils";
import { BundleFillsV3, BundleSlowFills, ExpiredDepositsToRefundV3 } from "../interfaces/BundleData";
export const { getImpliedBundleBlockRanges, getBlockRangeForChain, getBlockForChain, parseWinston, formatWinston } =
  utils;
import { any } from "superstruct";

// TODO: Move to SDK since this implements UMIP logic about validating block ranges.
// Return true if we won't be able to construct a root bundle for the bundle block ranges ("blockRanges") because
// the bundle wants to look up data for events that weren't in the spoke pool client's search range.
export type InvalidBlockRange = { chainId: number; reason: string };
export async function blockRangesAreInvalidForSpokeClients(
  spokePoolClients: Record<number, SpokePoolClient>,
  blockRanges: number[][],
  chainIdListForBundleEvaluationBlockNumbers: number[],
  earliestValidBundleStartBlock: { [chainId: number]: number },
  isV3 = false
): Promise<InvalidBlockRange[]> {
  assert(blockRanges.length === chainIdListForBundleEvaluationBlockNumbers.length);
  let endBlockTimestamps: { [chainId: number]: number } | undefined;
  if (isV3) {
    endBlockTimestamps = await getTimestampsForBundleEndBlocks(
      spokePoolClients,
      blockRanges,
      chainIdListForBundleEvaluationBlockNumbers
    );
    // There should be a spoke pool client instantiated for every bundle timestamp.
    assert(!Object.keys(endBlockTimestamps).some((chainId) => !isDefined(spokePoolClients[chainId])));
  }

  // Return an undefined object if the block ranges are valid
  return (
    await utils.mapAsync(blockRanges, async ([start, end], index): Promise<undefined | InvalidBlockRange> => {
      const chainId = chainIdListForBundleEvaluationBlockNumbers[index];
      if (isNaN(end) || isNaN(start)) {
        return {
          reason: `block range contains undefined block for: [isNaN(start): ${isNaN(start)}, isNaN(end): ${isNaN(
            end
          )}]`,
          chainId,
        };
      }
      if (start === end) {
        // If block range is 0 then chain is disabled, we don't need to query events for this chain.
        return undefined;
      }

      const spokePoolClient = spokePoolClients[chainId];

      // If spoke pool client doesn't exist for enabled chain then we clearly cannot query events for this chain.
      if (spokePoolClient === undefined) {
        return {
          reason: "spoke pool client undefined",
          chainId,
        };
      }

      const clientLastBlockQueried = spokePoolClient.latestBlockSearched;

      const earliestValidBundleStartBlockForChain =
        earliestValidBundleStartBlock?.[chainId] ?? spokePoolClient.deploymentBlock;

      // If range start block is less than the earliest spoke pool client we can validate or the range end block
      // is greater than the latest client end block, then ranges are invalid.
      // Note: Math.max the from block with the registration block of the spoke pool to handle the edge case for the first
      // bundle that set its start blocks equal 0.
      const bundleRangeFromBlock = Math.max(spokePoolClient.deploymentBlock, start);
      const bundleRangeFromBlockTooEarly = bundleRangeFromBlock < earliestValidBundleStartBlockForChain;
      const endGreaterThanClientLastBlockQueried = end > clientLastBlockQueried;
      if (bundleRangeFromBlockTooEarly || endGreaterThanClientLastBlockQueried) {
        return {
          reason: `${
            bundleRangeFromBlockTooEarly
              ? `bundleRangeFromBlock ${bundleRangeFromBlock} < earliestValidBundleStartBlockForChain ${earliestValidBundleStartBlockForChain}`
              : `end ${end} > clientLastBlockQueried ${clientLastBlockQueried}`
          }`,
          chainId,
        };
      }

      if (endBlockTimestamps !== undefined) {
        const maxFillDeadlineBufferInBlockRange = await spokePoolClient.getMaxFillDeadlineInRange(
          bundleRangeFromBlock,
          end
        );
        // Skip this check if the spokePoolClient.fromBlock is less than or equal to the spokePool deployment block.
        // In this case, we have all the information for this SpokePool possible so there are no older deposits
        // that might have expired that we might miss.
        const conservativeBundleFrequencySeconds = Number(
          process.env.CONSERVATIVE_BUNDLE_FREQUENCY_SECONDS ?? CONSERVATIVE_BUNDLE_FREQUENCY_SECONDS
        );
        if (spokePoolClient.eventSearchConfig.fromBlock > spokePoolClient.deploymentBlock) {
          // @dev The maximum lookback window we need to evaluate expired deposits is the max fill deadline buffer,
          // which captures all deposits that newly expired, plus the bundle time (e.g. 1 hour) to account for the
          // maximum time it takes for a newly expired deposit to be included in a bundle. A conservative value for
          // this bundle time is 3 hours. This `conservativeBundleFrequencySeconds` buffer also ensures that all deposits
          // that are technically "expired", but have fills in the bundle, are also included. This can happen if a fill
          // is sent pretty late into the deposit's expiry period.
          const oldestTime = await spokePoolClient.getTimeAt(spokePoolClient.eventSearchConfig.fromBlock);
          const expiryWindow = endBlockTimestamps[chainId] - oldestTime;
          const safeExpiryWindow = maxFillDeadlineBufferInBlockRange + conservativeBundleFrequencySeconds;
          if (expiryWindow < safeExpiryWindow) {
            return {
              reason: `cannot evaluate all possible expired deposits; endBlockTimestamp ${endBlockTimestamps[chainId]} - spokePoolClient.eventSearchConfig.fromBlock timestamp ${oldestTime} < maxFillDeadlineBufferInBlockRange ${maxFillDeadlineBufferInBlockRange} + conservativeBundleFrequencySeconds ${conservativeBundleFrequencySeconds}`,
              chainId,
            };
          }
        }
      }
      // We must now assume that all newly expired deposits at the time of the bundle end blocks are contained within
      // the spoke pool client's memory.

      // If we get to here, block ranges are valid, return false.
      return undefined;
    })
  ).filter(isDefined);
}

export function _buildSlowRelayRoot(bundleSlowFillsV3: BundleSlowFills): {
  leaves: SlowFillLeaf[];
  tree: MerkleTree<SlowFillLeaf>;
} {
  const slowRelayLeaves: SlowFillLeaf[] = [];

  // Append V3 slow fills to the V2 leaf list
  Object.values(bundleSlowFillsV3).forEach((depositsForChain) => {
    Object.values(depositsForChain).forEach((deposits) => {
      // Do not create slow fill leaves where the amount to transfer would be 0 and the message is empty
      deposits
        .filter((deposit) => !utils.isZeroValueDeposit(deposit))
        .forEach((deposit) => {
          const v3SlowFillLeaf = buildV3SlowFillLeaf(deposit, deposit.lpFeePct);
          slowRelayLeaves.push(v3SlowFillLeaf);
        });
    });
  });

  // Sort leaves deterministically so that the same root is always produced from the same loadData return value.
  // The { Deposit ID, origin chain ID } is guaranteed to be unique so we can sort on them.
  const sortedLeaves = [...slowRelayLeaves].sort((relayA, relayB) => {
    // Note: Smaller ID numbers will come first
    if (relayA.relayData.originChainId === relayB.relayData.originChainId) {
      return relayA.relayData.depositId.lt(relayB.relayData.depositId) ? -1 : 1;
    } else {
      return relayA.relayData.originChainId - relayB.relayData.originChainId;
    }
  });

  return {
    leaves: sortedLeaves,
    tree: buildSlowRelayTree(sortedLeaves),
  };
}

function buildV3SlowFillLeaf(deposit: interfaces.Deposit, lpFeePct: BigNumber): SlowFillLeaf {
  const lpFee = deposit.inputAmount.mul(lpFeePct).div(fixedPointAdjustment);

  return {
    relayData: {
      depositor: deposit.depositor,
      recipient: deposit.recipient,
      exclusiveRelayer: deposit.exclusiveRelayer,
      inputToken: deposit.inputToken,
      outputToken: deposit.outputToken,
      inputAmount: deposit.inputAmount,
      outputAmount: deposit.outputAmount,
      originChainId: deposit.originChainId,
      depositId: deposit.depositId,
      fillDeadline: deposit.fillDeadline,
      exclusivityDeadline: deposit.exclusivityDeadline,
      message: deposit.message,
    },
    chainId: deposit.destinationChainId,
    updatedOutputAmount: deposit.inputAmount.sub(lpFee),
  };
}

export type CombinedRefunds = {
  [repaymentChainId: number]: {
    [repaymentToken: string]: interfaces.Refund;
  };
};

export function _buildRelayerRefundRoot(
  endBlockForMainnet: number,
  bundleFillsV3: BundleFillsV3,
  expiredDepositsToRefundV3: ExpiredDepositsToRefundV3,
  poolRebalanceLeaves: PoolRebalanceLeaf[],
  runningBalances: RunningBalances,
  clients: DataworkerClients,
  maxRefundCount: number
): {
  leaves: RelayerRefundLeaf[];
  tree: MerkleTree<RelayerRefundLeaf>;
} {
  const relayerRefundLeaves: RelayerRefundLeafWithGroup[] = [];

  const combinedRefunds = getRefundsFromBundle(bundleFillsV3, expiredDepositsToRefundV3);

  // We'll construct a new leaf for each { repaymentChainId, L2TokenAddress } unique combination.
  Object.entries(combinedRefunds).forEach(([_repaymentChainId, refundsForChain]) => {
    const repaymentChainId = Number(_repaymentChainId);
    Object.entries(refundsForChain).forEach(([l2TokenAddress, refunds]) => {
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

      const _refundLeaves = _getRefundLeaves(refunds, amountToReturn, repaymentChainId, l2TokenAddress, maxRefundCount);
      relayerRefundLeaves.push(..._refundLeaves);
    });
  });

  // We need to construct a leaf for any pool rebalance leaves with a negative net send amount and NO fills to refund
  // since we need to return tokens from SpokePool to HubPool.
  poolRebalanceLeaves.forEach((leaf) => {
    leaf.netSendAmounts.forEach((netSendAmount, index) => {
      if (netSendAmount.gte(bnZero)) {
        return;
      }

      const l2TokenCounterpart = clients.hubPoolClient.getL2TokenForL1TokenAtBlock(
        leaf.l1Tokens[index],
        leaf.chainId,
        endBlockForMainnet
      );
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

export function _getRefundLeaves(
  refunds: Refund,
  amountToReturn: BigNumber,
  repaymentChainId: number,
  l2TokenAddress: string,
  maxRefundCount: number
): RelayerRefundLeafWithGroup[] {
  const nonZeroRefunds = Object.fromEntries(Object.entries(refunds).filter(([, refundAmount]) => refundAmount.gt(0)));
  // We need to sort leaves deterministically so that the same root is always produced from the same loadData
  // return value, so sort refund addresses by refund amount (descending) and then address (ascending).
  const sortedRefundAddresses = sortRefundAddresses(nonZeroRefunds);

  const relayerRefundLeaves: RelayerRefundLeafWithGroup[] = [];

  // Create leaf for { repaymentChainId, L2TokenAddress }, split leaves into sub-leaves if there are too many
  // refunds.
  for (let i = 0; i < sortedRefundAddresses.length; i += maxRefundCount) {
    const newLeaf = {
      groupIndex: i, // Will delete this group index after using it to sort leaves for the same chain ID and
      // L2 token address
      amountToReturn: i === 0 ? amountToReturn : bnZero,
      chainId: repaymentChainId,
      refundAmounts: sortedRefundAddresses.slice(i, i + maxRefundCount).map((address) => refunds[address]),
      leafId: 0, // Will be updated before inserting into tree when we sort all leaves.
      l2TokenAddress,
      refundAddresses: sortedRefundAddresses.slice(i, i + maxRefundCount),
    };
    assert(
      newLeaf.refundAmounts.length === newLeaf.refundAddresses.length,
      "refund address and amount array lengths mismatch"
    );
    relayerRefundLeaves.push(newLeaf);
  }
  return relayerRefundLeaves;
}

/**
 * @notice Returns WETH and ETH token addresses for chain if defined, or throws an error if they're not
 * in the hardcoded dictionary.
 * @param chainId chain to check for WETH and ETH addresses
 * @returns WETH and ETH addresses.
 */
function getWethAndEth(chainId: number): string[] {
  // Can't use TOKEN_SYMBOLS_MAP for ETH because it duplicates the WETH addresses, which is not correct for this use case.
  const wethAndEth = [TOKEN_SYMBOLS_MAP.WETH.addresses[chainId], CONTRACT_ADDRESSES[chainId].eth.address];
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

/**
 * Persists data to Arweave with a given tag, given that the data doesn't
 * already exist on Arweave with the tag.
 * @param client The Arweave client to use for persistence.
 * @param data The data to persist to Arweave.
 * @param logger A winston logger
 * @param tag The tag to use for the data.
 */
export async function persistDataToArweave(
  client: caching.ArweaveClient,
  data: Record<string, unknown>,
  logger: winston.Logger,
  tag?: string
): Promise<void> {
  assert(
    Buffer.from(tag).length <= ARWEAVE_TAG_BYTE_LIMIT,
    `Arweave tag cannot exceed ${ARWEAVE_TAG_BYTE_LIMIT} bytes`
  );

  const profiler = new Profiler({
    logger,
    at: "DataworkerUtils#persistDataToArweave",
  });
  const mark = profiler.start("persistDataToArweave");

  // Check if data already exists on Arweave with the given tag.
  // If so, we don't need to persist it again.
  const [matchingTxns, address, balance] = await Promise.all([
    client.getByTopic(tag, any()),
    client.getAddress(),
    client.getBalance(),
  ]);

  // Check balance. Maybe move this to Monitor function.
  const MINIMUM_AR_BALANCE = parseWinston("1");
  if (balance.lte(MINIMUM_AR_BALANCE)) {
    logger.error({
      at: "DataworkerUtils#persistDataToArweave",
      message: "Arweave balance is below minimum target balance",
      address,
      balance: formatWinston(balance),
      minimumBalance: formatWinston(MINIMUM_AR_BALANCE),
    });
  } else {
    logger.debug({
      at: "DataworkerUtils#persistDataToArweave",
      message: "Arweave balance is above minimum target balance",
      address,
      balance: formatWinston(balance),
      minimumBalance: formatWinston(MINIMUM_AR_BALANCE),
    });
  }

  if (matchingTxns.length > 0) {
    logger.debug({
      at: "DataworkerUtils#persistDataToArweave",
      message: `Data already exists on Arweave with tag: ${tag}`,
      hash: matchingTxns.map((txn) => txn.hash),
    });
  } else {
    const hashTxn = await client.set(data, tag);
    logger.info({
      at: "DataworkerUtils#persistDataToArweave",
      message: "Persisted data to Arweave! 💾",
      tag,
      receipt: `https://arweave.app/tx/${hashTxn}`,
      rawData: `https://arweave.net/${hashTxn}`,
      address,
      balance: formatWinston(balance),
      notificationPath: "across-arweave",
    });
    mark.stop({
      message: "Time to persist to Arweave",
    });
  }
}

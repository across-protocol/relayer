import * as _ from "lodash";
import {
  DepositWithBlock,
  FillsToRefund,
  FillWithBlock,
  ProposedRootBundle,
  SlowFillRequestWithBlock,
  SpokePoolClientsByChain,
  UnfilledDepositsForOriginChain,
  V3DepositWithBlock,
  V3FillWithBlock,
} from "../interfaces";
import { SpokePoolClient } from "../clients";
import {
  winston,
  BigNumber,
  bnZero,
  assignValidFillToFillsToRefund,
  getRefundInformationFromFill,
  updateTotalRefundAmount,
  updateTotalRealizedLpFeePct,
  flattenAndFilterUnfilledDepositsByOriginChain,
  updateUnfilledDepositsWithMatchedDeposit,
  getUniqueDepositsInRange,
  getUniqueEarlyDepositsInRange,
  queryHistoricalDepositForFill,
  assign,
  assert,
  fixedPointAdjustment,
} from "../utils";
import { Clients } from "../common";
import {
  getBlockRangeForChain,
  getImpliedBundleBlockRanges,
  getEndBlockBuffers,
  prettyPrintSpokePoolEvents,
  prettyPrintV3SpokePoolEvents,
} from "../dataworker/DataworkerUtils";
import { getWidestPossibleExpectedBlockRange, isChainDisabled } from "../dataworker/PoolRebalanceUtils";
import { typechain, utils, interfaces } from "@across-protocol/sdk-v2";
import {
  BundleDepositsV3,
  BundleExcessSlowFills,
  BundleFillsV3,
  BundleFillV3,
  BundleSlowFills,
  ExpiredDepositsToRefundV3,
  LoadDataReturnValue,
} from "../interfaces/BundleData";

type DataCache = Record<string, LoadDataReturnValue>;

// V3 dictionary helper functions
function updateExpiredDepositsV3(dict: ExpiredDepositsToRefundV3, deposit: V3DepositWithBlock): void {
  const { originChainId, inputToken } = deposit;
  if (!dict?.[originChainId]?.[inputToken]) {
    assign(dict, [originChainId, inputToken], []);
  }
  dict[originChainId][inputToken].push(deposit);
}

function updateBundleDepositsV3(dict: BundleDepositsV3, deposit: V3DepositWithBlock): void {
  const { originChainId, inputToken } = deposit;
  if (!dict?.[originChainId]?.[inputToken]) {
    assign(dict, [originChainId, inputToken], []);
  }
  dict[originChainId][inputToken].push(deposit);
}

function updateBundleFillsV3(
  dict: BundleFillsV3,
  fill: V3FillWithBlock,
  lpFeePct: BigNumber,
  repaymentChainId: number,
  repaymentToken: string
): void {
  if (!dict?.[repaymentChainId]?.[repaymentToken]) {
    assign(dict, [repaymentChainId, repaymentToken], {
      fills: [],
      totalRefundAmount: bnZero,
      realizedLpFees: bnZero,
      refunds: {},
    });
  }

  const bundleFill: BundleFillV3 = { ...fill, lpFeePct };

  // Add all fills, slow and fast, to dictionary.
  assign(dict, [repaymentChainId, repaymentToken, "fills"], [bundleFill]);

  // All fills update the bundle LP fees.
  const refundObj = dict[repaymentChainId][repaymentToken];
  const realizedLpFee = fill.inputAmount.mul(bundleFill.lpFeePct).div(fixedPointAdjustment);
  refundObj.realizedLpFees = refundObj.realizedLpFees ? refundObj.realizedLpFees.add(realizedLpFee) : realizedLpFee;

  // Only fast fills get refunded.
  if (!utils.isSlowFill(fill)) {
    const refundAmount = fill.inputAmount.mul(fixedPointAdjustment.sub(lpFeePct)).div(fixedPointAdjustment);
    refundObj.totalRefundAmount = refundObj.totalRefundAmount
      ? refundObj.totalRefundAmount.add(refundAmount)
      : refundAmount;

    // Instantiate dictionary if it doesn't exist.
    if (!refundObj.refunds) {
      assign(dict, [repaymentChainId, repaymentToken, "refunds"], {});
    }

    if (refundObj.refunds[fill.relayer]) {
      refundObj.refunds[fill.relayer] = refundObj.refunds[fill.relayer].add(refundAmount);
    } else {
      refundObj.refunds[fill.relayer] = refundAmount;
    }
  }
}

function updateBundleExcessSlowFills(dict: BundleExcessSlowFills, deposit: V3DepositWithBlock): void {
  const { destinationChainId, outputToken } = deposit;
  if (!dict?.[destinationChainId]?.[outputToken]) {
    assign(dict, [destinationChainId, outputToken], []);
  }
  dict[destinationChainId][outputToken].push(deposit);
}

function updateBundleSlowFills(dict: BundleSlowFills, deposit: V3DepositWithBlock): void {
  const { destinationChainId, outputToken } = deposit;
  if (!dict?.[destinationChainId]?.[outputToken]) {
    assign(dict, [destinationChainId, outputToken], []);
  }
  assert(deposit.realizedLpFeePct, "Deposit must have realizedLpFeePct to store as BundleSlowFill");
  dict[destinationChainId][outputToken].push(deposit);
}

// @notice Shared client for computing data needed to construct or validate a bundle.
export class BundleDataClient {
  private loadDataCache: DataCache = {};

  // eslint-disable-next-line no-useless-constructor
  constructor(
    readonly logger: winston.Logger,
    readonly clients: Clients,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly chainIdListForBundleEvaluationBlockNumbers: number[],
    readonly blockRangeEndBlockBuffer: { [chainId: number]: number } = {}
  ) {}

  // This should be called whenever it's possible that the loadData information for a block range could have changed.
  // For instance, if the spoke or hub clients have been updated, it probably makes sense to clear this to be safe.
  clearCache(): void {
    this.loadDataCache = {};
  }

  loadDataFromCache(key: string): LoadDataReturnValue {
    // Always return a deep cloned copy of object stored in cache. Since JS passes by reference instead of value, we
    // want to minimize the risk that the programmer accidentally mutates data in the cache.
    return _.cloneDeep(this.loadDataCache[key]);
  }

  async getPendingRefundsFromValidBundles(bundleLookback: number): Promise<FillsToRefund[]> {
    const refunds = [];
    if (!this.clients.hubPoolClient.isUpdated) {
      throw new Error("BundleDataClient::getPendingRefundsFromValidBundles HubPoolClient not updated.");
    }

    let latestBlock = this.clients.hubPoolClient.latestBlockSearched;
    for (let i = 0; i < bundleLookback; i++) {
      const bundle = this.clients.hubPoolClient.getLatestFullyExecutedRootBundle(latestBlock);
      if (bundle !== undefined) {
        // Update latest block so next iteration can get the next oldest bundle:
        latestBlock = bundle.blockNumber;
        refunds.push(await this.getPendingRefundsFromBundle(bundle));
      } else {
        break;
      } // No more valid bundles in history!
    }
    return refunds;
  }

  // Return refunds from input bundle.
  async getPendingRefundsFromBundle(bundle: ProposedRootBundle): Promise<FillsToRefund> {
    // Reconstruct latest bundle block range.
    const bundleEvaluationBlockRanges = getImpliedBundleBlockRanges(
      this.clients.hubPoolClient,
      this.clients.configStoreClient,
      bundle
    );
    const { fillsToRefund } = await this.loadData(bundleEvaluationBlockRanges, this.spokePoolClients, false);

    // The latest proposed bundle's refund leaves might have already been partially or entirely executed.
    // We have to deduct the executed amounts from the total refund amounts.
    return this.deductExecutedRefunds(fillsToRefund, bundle);
  }

  // Return refunds from the next valid bundle. This will contain any refunds that have been sent but are not included
  // in a valid bundle with all of its leaves executed. This contains refunds from:
  // - Bundles that passed liveness but have not had all of their pool rebalance leaves executed.
  // - Bundles that are pending liveness
  // - Not yet proposed bundles
  async getNextBundleRefunds(): Promise<FillsToRefund> {
    const futureBundleEvaluationBlockRanges = getWidestPossibleExpectedBlockRange(
      this.chainIdListForBundleEvaluationBlockNumbers,
      this.spokePoolClients,
      getEndBlockBuffers(this.chainIdListForBundleEvaluationBlockNumbers, this.blockRangeEndBlockBuffer),
      this.clients,
      this.clients.hubPoolClient.latestBlockSearched,
      this.clients.configStoreClient.getEnabledChains(this.clients.hubPoolClient.latestBlockSearched)
    );
    // Refunds that will be processed in the next bundle that will be proposed after the current pending bundle
    // (if any) has been fully executed.
    return (await this.loadData(futureBundleEvaluationBlockRanges, this.spokePoolClients, false)).fillsToRefund;
  }

  deductExecutedRefunds(allRefunds: FillsToRefund, bundleContainingRefunds: ProposedRootBundle): FillsToRefund {
    for (const chainIdStr of Object.keys(allRefunds)) {
      const chainId = Number(chainIdStr);
      const executedRefunds = this.spokePoolClients[chainId].getExecutedRefunds(
        bundleContainingRefunds.relayerRefundRoot
      );

      for (const tokenAddress of Object.keys(allRefunds[chainId])) {
        const refunds = allRefunds[chainId][tokenAddress].refunds;
        if (executedRefunds[tokenAddress] === undefined || refunds === undefined) {
          continue;
        }

        for (const relayer of Object.keys(refunds)) {
          const executedAmount = executedRefunds[tokenAddress][relayer];
          if (executedAmount === undefined) {
            continue;
          }
          // Depending on how far we lookback when loading deposits/fills events, we might be missing some valid
          // refunds in the bundle calculation. If relayer refund leaves are executed later and all the executions are
          // within the lookback period but the corresponding deposits/fills are not, we can run into cases where
          // executedAmount > refunds[relayer].
          refunds[relayer] = executedAmount.gt(refunds[relayer]) ? bnZero : refunds[relayer].sub(executedAmount);
        }
      }
    }
    return allRefunds;
  }

  getRefundsFor(bundleRefunds: FillsToRefund, relayer: string, chainId: number, token: string): BigNumber {
    if (!bundleRefunds[chainId] || !bundleRefunds[chainId][token]) {
      return BigNumber.from(0);
    }
    const allRefunds = bundleRefunds[chainId][token].refunds;
    return allRefunds && allRefunds[relayer] ? allRefunds[relayer] : BigNumber.from(0);
  }

  getTotalRefund(refunds: FillsToRefund[], relayer: string, chainId: number, refundToken: string): BigNumber {
    return refunds.reduce((totalRefund, refunds) => {
      return totalRefund.add(this.getRefundsFor(refunds, relayer, chainId, refundToken));
    }, bnZero);
  }

  // Common data re-formatting logic shared across all data worker public functions.
  // User must pass in spoke pool to search event data against. This allows the user to refund relays and fill deposits
  // on deprecated spoke pools.
  async loadData(
    blockRangesForChains: number[][],
    spokePoolClients: SpokePoolClientsByChain,
    logData = true
  ): Promise<LoadDataReturnValue> {
    const key = JSON.stringify(blockRangesForChains);

    if (this.loadDataCache[key]) {
      return this.loadDataFromCache(key);
    }

    if (!this.clients.configStoreClient.isUpdated) {
      throw new Error("ConfigStoreClient not updated");
    } else if (!this.clients.hubPoolClient.isUpdated) {
      throw new Error("HubPoolClient not updated");
    }

    if (blockRangesForChains.length > this.chainIdListForBundleEvaluationBlockNumbers.length) {
      throw new Error(
        `Unexpected block range list length of ${blockRangesForChains.length}, should be <= ${this.chainIdListForBundleEvaluationBlockNumbers.length}`
      );
    }

    const unfilledDepositsForOriginChain: UnfilledDepositsForOriginChain = {};
    const fillsToRefund: FillsToRefund = {};
    const allRelayerRefunds: { repaymentChain: number; repaymentToken: string }[] = [];
    const deposits: DepositWithBlock[] = [];
    const allValidFills: FillWithBlock[] = [];
    const allInvalidFills: FillWithBlock[] = [];
    const earlyDeposits: typechain.FundsDepositedEvent[] = [];

    // V3 specific objects:
    const bundleDepositsV3: BundleDepositsV3 = {}; // Deposits in bundle block range.
    const bundleFillsV3: BundleFillsV3 = {}; // Fills to refund in bundle block range.
    const bundleInvalidFillsV3: V3FillWithBlock[] = []; // Fills that are not valid in this bundle.
    const bundleSlowFillsV3: BundleSlowFills = {}; // Deposits that we need to send slow fills
    // for in this bundle.
    const expiredDepositsToRefundV3: ExpiredDepositsToRefundV3 = {};
    // Newly expired deposits in this bundle that need to be refunded.
    const unexecutableSlowFills: BundleExcessSlowFills = {};
    // Deposit data for all Slowfills that were included in a previous
    // bundle and can no longer be executed because (1) they were replaced with a FastFill in this bundle or
    // (2) the fill deadline has passed. We'll need to decrement running balances for these deposits on the
    // destination chain where the slow fill would have been executed.

    // Save refund in-memory for validated fill.
    const addRefundForValidFill = (
      fillWithBlock: FillWithBlock,
      matchedDeposit: DepositWithBlock,
      blockRangeForChain: number[]
    ) => {
      // Extra check for duplicate fills. These should be blocked at the contract level but might still be included
      // by the RPC so its worth checking here.
      const duplicateFill = allValidFills.find(
        (existingFill) =>
          existingFill.originChainId === fillWithBlock.originChainId &&
          existingFill.depositId === fillWithBlock.depositId &&
          utils.getTotalFilledAmount(existingFill).eq(utils.getTotalFilledAmount(fillWithBlock))
      );
      if (duplicateFill !== undefined) {
        this.logger.warn({
          at: "BundleDataClient#loadData",
          message: "Tried to add refund for duplicate fill. Skipping.",
          duplicateFill,
          matchedDeposit,
        });
        return;
      }
      // Fill was validated. Save it under all validated fills list with the block number so we can sort it by
      // time. Note that its important we don't skip fills earlier than the block range at this step because
      // we use allValidFills to find the first fill in the entire history associated with a fill in the block
      // range, in order to determine if we already sent a slow fill for it.
      allValidFills.push(fillWithBlock);

      // If fill is outside block range, we can skip it now since we're not going to add a refund for it.
      if (fillWithBlock.blockNumber < blockRangeForChain[0]) {
        return;
      }

      // Now create a copy of fill with block data removed, and use its data to update the fills to refund obj.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { blockNumber, transactionIndex, transactionHash, logIndex, ...fill } = fillWithBlock;
      const { chainToSendRefundTo, repaymentToken } = getRefundInformationFromFill(
        fill,
        this.clients.hubPoolClient,
        blockRangesForChains,
        this.chainIdListForBundleEvaluationBlockNumbers
      );

      // Fills to refund includes both slow and non-slow fills and they both should increase the
      // total realized LP fee %.
      assignValidFillToFillsToRefund(fillsToRefund, fill, chainToSendRefundTo, repaymentToken);
      allRelayerRefunds.push({ repaymentToken, repaymentChain: chainToSendRefundTo });

      updateTotalRealizedLpFeePct(fillsToRefund, fill, chainToSendRefundTo, repaymentToken);

      // Save deposit as one that is eligible for a slow fill, since there is a fill
      // for the deposit in this epoch. We save whether this fill is the first fill for the deposit, because
      // if a deposit has its first fill in this block range, then we can send a slow fill payment to complete
      // the deposit. If other fills end up completing this deposit, then we'll remove it from the unfilled
      // deposits later.
      updateUnfilledDepositsWithMatchedDeposit(fill, matchedDeposit, unfilledDepositsForOriginChain);

      // Update total refund counter for convenience when constructing relayer refund leaves
      updateTotalRefundAmount(fillsToRefund, fill, chainToSendRefundTo, repaymentToken);
    };

    const validateFillAndSaveData = async (fill: FillWithBlock, blockRangeForChain: number[]): Promise<void> => {
      const originClient = spokePoolClients[fill.originChainId];
      const matchedDeposit = originClient.getDepositForFill(fill);
      if (matchedDeposit) {
        addRefundForValidFill(fill, matchedDeposit, blockRangeForChain);
      } else {
        // Matched deposit for fill was not found in spoke client. This situation should be rare so let's
        // send some extra RPC requests to blocks older than the spoke client's initial event search config
        // to find the deposit if it exists.
        const spokePoolClient = spokePoolClients[fill.originChainId];
        const historicalDeposit = await queryHistoricalDepositForFill(spokePoolClient, fill);
        if (historicalDeposit.found) {
          addRefundForValidFill(fill, historicalDeposit.deposit, blockRangeForChain);
        } else {
          allInvalidFills.push(fill);
        }
      }
    };

    const _isChainDisabled = (chainId: number): boolean => {
      const blockRangeForChain = getBlockRangeForChain(
        blockRangesForChains,
        chainId,
        this.chainIdListForBundleEvaluationBlockNumbers
      );
      return isChainDisabled(blockRangeForChain);
    };

    // Infer chain ID's to load from number of block ranges passed in.
    const allChainIds = blockRangesForChains
      .map((_blockRange, index) => this.chainIdListForBundleEvaluationBlockNumbers[index])
      .filter((chainId) => !_isChainDisabled(chainId));
    allChainIds.forEach((chainId) => {
      const spokePoolClient = spokePoolClients[chainId];
      if (!spokePoolClient.isUpdated) {
        throw new Error(`SpokePoolClient for chain ${chainId} not updated.`);
      }
    });

    // If spoke pools are V3 contracts, then we need to compute start and end timestamps for block ranges to
    // determine whether fillDeadlines have expired.
    // @dev Going to leave this in so we can see impact on run-time in prod. This makes (allChainIds.length * 2) RPC
    // calls in parallel.
    const bundleBlockTimestamps: { [chainId: string]: number[] } = await this.getBundleBlockTimestamps(
      allChainIds,
      blockRangesForChains,
      spokePoolClients
    );

    /** *****************************
     *
     * Handle LEGACY events
     *
     * *****************************/
    for (const originChainId of allChainIds) {
      if (_isChainDisabled(originChainId)) {
        continue;
      }

      const originClient = spokePoolClients[originChainId];

      // Loop over all other SpokePoolClient's to find deposits whose destination chain is the selected origin chain.
      for (const destinationChainId of allChainIds) {
        if (originChainId === destinationChainId) {
          continue;
        }
        if (_isChainDisabled(destinationChainId)) {
          continue;
        }

        const destinationClient = spokePoolClients[destinationChainId];

        // Store all deposits in range, for use in constructing a pool rebalance root. Save deposits with
        // their quote time block numbers so we can pull the L1 token counterparts for the quote timestamp.
        // We can safely filter `deposits` by the bundle block range because its only used to decrement running
        // balances in the pool rebalance root. This array is NOT used when matching fills with deposits. For that,
        // we use the wider event search config of the origin client.
        deposits.push(
          ...getUniqueDepositsInRange(
            blockRangesForChains,
            Number(originChainId),
            Number(destinationChainId),
            this.chainIdListForBundleEvaluationBlockNumbers,
            originClient,
            deposits
          )
        );

        // TODO: replace this logic with something more clear where all deposits can be queried at once,
        // but separated into early and not after the initial filter/query.
        earlyDeposits.push(
          ...getUniqueEarlyDepositsInRange(
            blockRangesForChains,
            Number(originChainId),
            Number(destinationChainId),
            this.chainIdListForBundleEvaluationBlockNumbers,
            originClient,
            earlyDeposits
          )
        );

        const blockRangeForChain = getBlockRangeForChain(
          blockRangesForChains,
          Number(destinationChainId),
          this.chainIdListForBundleEvaluationBlockNumbers
        );

        // Find all valid fills matching a deposit on the origin chain and sent on the destination chain.
        // Don't include any fills past the bundle end block for the chain, otherwise the destination client will
        // return fill events that are younger than the bundle end block.
        const fillsForOriginChain = destinationClient
          .getFillsForOriginChain(Number(originChainId))
          .filter(
            (fillWithBlock) => utils.isV2Fill(fillWithBlock) && fillWithBlock.blockNumber <= blockRangeForChain[1]
          );
        await Promise.all(fillsForOriginChain.map((fill) => validateFillAndSaveData(fill, blockRangeForChain)));
      }
    }

    /** *****************************
     *
     * Handle V3 events
     *
     * *****************************/

    // Use this dictionary to conveniently unite all events with the same relay data hash which will make
    // secondary lookups faster. The goal is to lazily fill up this dictionary with all events in the SpokePool
    // client's in-memory event cache.
    const v3RelayHashes: {
      [relayHash: string]: {
        // Note: Since there are no partial fills in v3, there should only be one fill per relay hash.
        // There should also only be one deposit per relay hash since deposit ID's can't be re-used on the
        // same spoke pool. Moreover, the SpokePool blocks multiple slow fill requests, so
        // there should also only be one slow fill request per relay hash.
        deposit: V3DepositWithBlock;
        fill: V3FillWithBlock;
        slowFillRequest: SlowFillRequestWithBlock;
      };
    } = {};

    // Process all deposits first:
    const expiredBundleDepositHashes: Set<string> = new Set<string>();
    const olderDepositHashes: Set<string> = new Set<string>();
    for (const originChainId of allChainIds) {
      const originClient = spokePoolClients[originChainId];

      for (const destinationChainId of allChainIds) {
        if (originChainId === destinationChainId) {
          continue;
        }

        const originChainBlockRange = getBlockRangeForChain(
          blockRangesForChains,
          originChainId,
          this.chainIdListForBundleEvaluationBlockNumbers
        );
        //       Load all deposits in block range:
        //         - add it to bundleDepositsV3.
        //         If deposit.fillDeadline <= bundleBlockTimestamps[destinationChain][1], its expired:
        //         - Add it to expiredDepositsToRefund.
        originClient.getDepositsForDestinationChain(destinationChainId).forEach((deposit: DepositWithBlock) => {
          if (utils.isV3Deposit(deposit)) {
            const relayDataHash = utils.getV3RelayHashFromEvent(deposit);
            if (!v3RelayHashes[relayDataHash]) {
              // Even if deposit is not in bundle block range, store all deposits we can see in memory in this
              // convenient dictionary.
              v3RelayHashes[relayDataHash] = {
                deposit: deposit,
                fill: undefined,
                slowFillRequest: undefined,
              };

              if (deposit.blockNumber <= originChainBlockRange[1] && deposit.blockNumber >= originChainBlockRange[0]) {
                // Deposit is a V3 deposit in this origin chain's bundle block range and is not a duplicate.
                updateBundleDepositsV3(bundleDepositsV3, deposit);
                // We don't check that fillDeadline >= bundleBlockTimestamps[destinationChainId][0] because
                // that would eliminate any deposits in this bundle with a very low fillDeadline like equal to 0
                // for example. Those should be impossible to create but technically should be included in this
                // bundle of refunded deposits.
                if (deposit.fillDeadline <= bundleBlockTimestamps[destinationChainId][1]) {
                  expiredBundleDepositHashes.add(relayDataHash);
                }
              } else if (deposit.blockNumber < originChainBlockRange[0]) {
                olderDepositHashes.add(relayDataHash);
              }
            } else {
              // If we've seen this deposit before, then skip this deposit. This can happen if our RPC provider
              // gives us bad data.
            }
          }
        });
      }
    }

    // Process fills now that we've populated relay hash dictionary with deposits:
    const validBundleFillHashes: Set<string> = new Set<string>();
    const validFillHashes: Set<string> = new Set<string>();
    for (const originChainId of allChainIds) {
      const originClient = spokePoolClients[originChainId];
      for (const destinationChainId of allChainIds) {
        if (originChainId === destinationChainId) {
          continue;
        }

        const destinationClient = spokePoolClients[destinationChainId];
        const destinationChainBlockRange = getBlockRangeForChain(
          blockRangesForChains,
          destinationChainId,
          this.chainIdListForBundleEvaluationBlockNumbers
        );

        //       Load all fills:
        //        Validate fill. Conveniently can use relayHashes to find the matching deposit quickly, if it exists
        //         or fallback to queryHistoricalDepositForV3Fill if depositId < spokePoolClient.firstDepositIdSearched.
        //        If fill is valid:
        //            - Add it to bundleV3Fills. If its not a SlowFill, add it as a refund. All fills should increment
        //              bundle LP fees.

        const relayHashesForExcessSlowFills: string[] = [];
        await utils.forEachAsync(
          destinationClient.getFillsForOriginChain(originChainId),
          async (fill: FillWithBlock) => {
            if (utils.isV3Fill(fill)) {
              const relayDataHash = utils.getV3RelayHashFromEvent(fill);

              const { chainToSendRefundTo, repaymentToken } = getRefundInformationFromFill(
                fill,
                this.clients.hubPoolClient,
                blockRangesForChains,
                this.chainIdListForBundleEvaluationBlockNumbers
              );

              // Instantiate dictionary if there isn't a deposit matching it.
              if (!v3RelayHashes[relayDataHash]) {
                v3RelayHashes[relayDataHash] = {
                  deposit: undefined,
                  fill: fill,
                  slowFillRequest: undefined,
                };

                // TODO: We might be able to remove the following historical query once we deprecate the deposit()
                // function since there won't be any old, unexpired deposits anymore assuming the spoke pool client
                // lookbacks have been validated, which they should be before we run this function.

                // Since there was no deposit matching the relay hash, we need to do a historical query for an
                // older deposit in case the spoke pool client's lookback isn't old enough to find the matching deposit.
                if (
                  fill.blockNumber <= destinationChainBlockRange[1] &&
                  fill.blockNumber >= destinationChainBlockRange[0]
                ) {
                  // If fill is a slow fill, then no need to query a historical deposit for it since we can assume
                  // all slow fills are valid.
                  if (fill.relayExecutionInfo.fillType === interfaces.FillType.SlowFill) {
                    // We can back out the lp fee for slow fill executions by using the difference between
                    // the input amount and the updated or "executed" output amount.
                    const lpFeePct = fill.inputAmount
                      .sub(fill.relayExecutionInfo.updatedOutputAmount)
                      .mul(fixedPointAdjustment)
                      .div(fill.inputAmount);
                    updateBundleFillsV3(bundleFillsV3, fill, lpFeePct, chainToSendRefundTo, repaymentToken);
                    validBundleFillHashes.add(relayDataHash);
                  } else {
                    const historicalDeposit = await queryHistoricalDepositForFill(originClient, fill);
                    if (historicalDeposit.found && utils.isV3Deposit(historicalDeposit.deposit)) {
                      const matchedDeposit: V3DepositWithBlock = historicalDeposit.deposit;
                      // @dev Since queryHistoricalDepositForFill validates the fill by checking individual
                      // object property values against the deposit's, we
                      // sanity check it here by comparing the full relay hashes
                      if (utils.getV3RelayHashFromEvent(matchedDeposit) === relayDataHash) {
                        updateBundleFillsV3(
                          bundleFillsV3,
                          fill,
                          matchedDeposit.realizedLpFeePct,
                          chainToSendRefundTo,
                          repaymentToken
                        );
                        validBundleFillHashes.add(relayDataHash);
                        if (fill.relayExecutionInfo.fillType === interfaces.FillType.ReplacedSlowFill) {
                          relayHashesForExcessSlowFills.push(relayDataHash);
                        }
                      } else {
                        bundleInvalidFillsV3.push(fill);
                      }
                    } else {
                      bundleInvalidFillsV3.push(fill);
                    }
                  }
                }
              } else {
                if (!v3RelayHashes[relayDataHash].fill) {
                  validFillHashes.add(relayDataHash);
                  // At this point, the v3RelayHashes entry already existed meaning that there is a matching deposit,
                  // so this fill is validated.
                  assert(v3RelayHashes[relayDataHash].deposit, "Deposit should exist in relay hash dictionary.");
                  v3RelayHashes[relayDataHash].fill = fill;
                  if (
                    fill.blockNumber <= destinationChainBlockRange[1] &&
                    fill.blockNumber >= destinationChainBlockRange[0]
                  ) {
                    // TODO: Once realizedLpFeePct is based on repaymentChain and originChain, it will
                    // be included in the Fill type rather than the Deposit type
                    updateBundleFillsV3(
                      bundleFillsV3,
                      fill,
                      v3RelayHashes[relayDataHash].deposit.realizedLpFeePct,
                      chainToSendRefundTo,
                      repaymentToken
                    );
                    validBundleFillHashes.add(relayDataHash);
                    if (fill.relayExecutionInfo.fillType === interfaces.FillType.ReplacedSlowFill) {
                      relayHashesForExcessSlowFills.push(relayDataHash);
                    }
                  }

                  // If fill is not within bundle range there is nothing more to do since we've already
                  // added the fill to the relay hash dictionary.
                } else {
                  // If we've seen this fill before, then skip this fill. This can happen if our RPC provider
                  // gives us bad data.
                }
              }
            }
          }
        );

        //       Load all slow fill requests:
        //        Validate slow fill. Conveniently can use relayHashes to find the matching deposit quickly, if it exists
        //         or fallback to queryHistoricalDepositForV3Fill if depositId < spokePoolClient.firstDepositIdSearched.
        //        If slow fill request is valid and does not match a fast fill in the bundle:
        //          - Add it to bundleSlowFills.
        //          - The fill should have an lpFee so we can use it to derive the updatedOutputAmount
        //        Else, do nothing, as the slow fill request is invalid.

        await utils.forEachAsync(
          destinationClient.getSlowFillRequestsForOriginChain(originChainId),
          async (slowFillRequest: SlowFillRequestWithBlock) => {
            const relayDataHash = utils.getV3RelayHashFromEvent(slowFillRequest);

            // Instantiate dictionary if there isn't a deposit or fill matching it.
            if (!v3RelayHashes[relayDataHash]) {
              v3RelayHashes[relayDataHash] = {
                deposit: undefined,
                fill: undefined,
                slowFillRequest: slowFillRequest,
              };

              // TODO: We might be able to remove the following historical query once we deprecate the deposit()
              // function since there won't be any old, unexpired deposits anymore assuming the spoke pool client
              // lookbacks have been validated, which they should be before we run this function.

              // Since there was no deposit matching the relay hash, we need to do a historical query for an
              // older deposit in case the spoke pool client's lookback isn't old enough to find the matching deposit.
              if (
                slowFillRequest.blockNumber <= destinationChainBlockRange[1] &&
                slowFillRequest.blockNumber >= destinationChainBlockRange[0]
              ) {
                const historicalDeposit = await queryHistoricalDepositForFill(originClient, slowFillRequest);
                if (historicalDeposit.found && utils.isV3Deposit(historicalDeposit.deposit)) {
                  const matchedDeposit: V3DepositWithBlock = historicalDeposit.deposit;
                  if (
                    // @dev Since queryHistoricalDepositForFill validates the fill by checking individual
                    // object property values against the deposit's, we
                    // sanity check it here by comparing the full relay hashes
                    utils.getV3RelayHashFromEvent(matchedDeposit) === relayDataHash &&
                    this.clients.hubPoolClient.areTokensEquivalent(
                      matchedDeposit.inputToken,
                      matchedDeposit.originChainId,
                      matchedDeposit.outputToken,
                      matchedDeposit.destinationChainId,
                      matchedDeposit.quoteBlockNumber
                    )
                  ) {
                    // TODO: Once realizedLpFeePct is based on repaymentChain and originChain, it will
                    // be included in the Fill type rather than the Deposit type, so we'll need
                    // to compute it fresh here.
                    updateBundleSlowFills(bundleSlowFillsV3, historicalDeposit.deposit);
                  } else {
                    // TODO: Invalid slow fill request. Maybe worth logging.
                  }
                } else {
                  // TODO: Invalid slow fill request. Maybe worth logging.
                }
              }
            } else {
              if (!v3RelayHashes[relayDataHash].slowFillRequest) {
                // At this point, the v3RelayHashes entry already existed meaning that there is a matching deposit,
                // so this fill is validated.
                assert(v3RelayHashes[relayDataHash].deposit, "Deposit should exist in relay hash dictionary.");
                v3RelayHashes[relayDataHash].slowFillRequest = slowFillRequest;
                const matchedDeposit = v3RelayHashes[relayDataHash].deposit;

                // If there is no fill matching the relay hash, then this might be a valid slow fill request
                // that we should produce a slow fill leaf for. If there was a fill in this bundle we would have
                // seen it already by processing fills in the loop above.
                if (
                  !v3RelayHashes[relayDataHash].fill &&
                  slowFillRequest.blockNumber <= destinationChainBlockRange[1] &&
                  slowFillRequest.blockNumber >= destinationChainBlockRange[0] &&
                  this.clients.hubPoolClient.areTokensEquivalent(
                    matchedDeposit.inputToken,
                    matchedDeposit.originChainId,
                    matchedDeposit.outputToken,
                    matchedDeposit.destinationChainId,
                    matchedDeposit.quoteBlockNumber
                  )
                ) {
                  // At this point, the v3RelayHashes entry already existed meaning that there is a matching deposit,
                  // so this slow fill request is validated.
                  updateBundleSlowFills(bundleSlowFillsV3, matchedDeposit);
                  // TODO: Once realizedLpFeePct is based on repaymentChain and originChain, it will
                  // be included in the Fill type rather than the Deposit type, so we'll need
                  // to compute it fresh here.
                }
              } else {
                // If we've seen this request before, then skip this event. This can happen if our RPC provider
                // gives us bad data.
              }
            }
          }
        );

        //        Now that we've saved slow fill requests and fast fills, go through all fast fills and identify those
        //        that replaced a slow fill request from a previous bundle.
        //            - If fillType is ReplacedSlowFill and there is no RequestSlowFill matching the relayHash in this bundle,
        //              then we'll want to decrement runningBalances on destination chain since a
        //              slow fill leaf was included in a previous bundle but cannot be executed.
        //              Save this fill/deposit in unexecutableSlowFills.
        relayHashesForExcessSlowFills.forEach((relayDataHash) => {
          const { deposit, slowFillRequest, fill } = v3RelayHashes[relayDataHash];
          assert(
            fill.relayExecutionInfo.fillType === interfaces.FillType.ReplacedSlowFill,
            "Fill type should be ReplacedSlowFill."
          );
          const destinationBlockRange = getBlockRangeForChain(
            blockRangesForChains,
            destinationChainId,
            this.chainIdListForBundleEvaluationBlockNumbers
          );
          if (
            // If the slow fill request that was replaced by this fill was in an older bundle, then we don't
            // need to check if the slow fill request was valid since we can assume all bundles in the past
            // were validated. However, we might as well double check.
            this.clients.hubPoolClient.areTokensEquivalent(
              deposit.inputToken,
              deposit.originChainId,
              deposit.outputToken,
              deposit.destinationChainId,
              deposit.quoteBlockNumber
            ) &&
            // If there is a slow fill request in this bundle that matches the relay hash, then there was no slow fill
            // created that would be considered excess.
            (!slowFillRequest || slowFillRequest.blockNumber < destinationBlockRange[0])
          ) {
            // @dev The dataworker will be able to reconstruct the slow fill updatedOutputAmount using the deposit
            // realiedLpFeePct and outputAmount.
            updateBundleExcessSlowFills(unexecutableSlowFills, deposit);
          }
        });
      }
    }

    // Go through expired deposits in this bundle and now prune those that we have seen a fill for.
    expiredBundleDepositHashes.forEach((relayDataHash) => {
      if (!validBundleFillHashes.has(relayDataHash)) {
        const deposit = v3RelayHashes[relayDataHash].deposit;
        assert(deposit, "Deposit should exist in relay hash dictionary.");
        updateExpiredDepositsV3(expiredDepositsToRefundV3, deposit);
      }
    });

    //     For all other deposits older than this chain's block range (with blockNumber < origin blockRange[0]):
    //       - Check for newly expired deposits where fillDeadline <= bundleBlockTimestamps[destinationChain][1]
    //        and fillDeadline >= bundleBlockTimestamps[destinationChain][0].
    //       - We need to figure out whether these older deposits have been filled already and also whether
    //        they have had slow fill payments sent for them in a previous bundle.
    //       - First, see if these deposits are matched with a fill in the dictionary of unique deposits we
    //        created earlier. Remove such deposits.
    //       - If not, then call SpokePool.fillStatuses() for each of these deposits.
    //        ( This does open us up to a minor griefing vector where someone
    //          sends many small deposits with a short fill deadline, making us call fillStatuses() many times.
    //          This is mitigated because the deposit would have to have been sent in a previous bundle but with a
    //          fillDeadline that ended in this current bundle. )
    //       - Remove any deposits whose fillStatus is Filled
    //       - For the deposits whose fillStatus is Unfilled, add them to depositsToRefund and increment running
    //         balances on the origin chain.
    //       - For the deposits whose fillStatus is RequestedSlowFill, we'll need to subtract their refund amount
    //         from running balances on the destination chain since we can no longer execute the slow fill leaf
    //         that was included in a previous bundle, so let's add them to unexecutableSlowFills.
    await utils.forEachAsync([...olderDepositHashes], async (relayDataHash) => {
      const deposit = v3RelayHashes[relayDataHash].deposit;
      assert(deposit, "Deposit should exist in relay hash dictionary.");
      const { destinationChainId } = deposit;

      // Only look for deposits that were mined before this bundle and that are newly expired.
      // If the fill deadline is lower than the bundle start block on the destination chain, then
      // we should assume it was marked "newly expired" and refunded in a previous bundle.
      if (
        // If there is a valid fill that we saw matching this deposit, then it does not need a refund.
        !validFillHashes.has(relayDataHash) &&
        deposit.fillDeadline <= bundleBlockTimestamps[destinationChainId][1] &&
        deposit.fillDeadline >= bundleBlockTimestamps[destinationChainId][0]
      ) {
        const fillStatus: BigNumber = await spokePoolClients[deposit.destinationChainId].spokePool.fillStatuses(
          relayDataHash
        );
        if (fillStatus.eq(interfaces.FillStatus.Unfilled)) {
          updateExpiredDepositsV3(expiredDepositsToRefundV3, deposit);
        } else if (fillStatus.eq(interfaces.FillStatus.RequestedSlowFill)) {
          updateBundleExcessSlowFills(unexecutableSlowFills, deposit);
          updateExpiredDepositsV3(expiredDepositsToRefundV3, deposit);
        }
      }
    });

    // Clean up:
    // - Check for duplicate events in any of the above lists.

    // Note: We do not check for duplicate slow fills here since `addRefundForValidFill` already checks for duplicate
    // fills and is the function that populates the `unfilledDeposits` dictionary. Therefore, if there are no duplicate
    // fills, then there won't be duplicate `matchedDeposits` used to populate `unfilledDeposits`.
    // For each deposit with a matched fill, figure out the unfilled amount that we need to slow relay. We will filter
    // out any deposits that are fully filled.
    const unfilledDeposits = flattenAndFilterUnfilledDepositsByOriginChain(unfilledDepositsForOriginChain);

    const spokeEventsReadable = prettyPrintSpokePoolEvents(
      blockRangesForChains,
      this.chainIdListForBundleEvaluationBlockNumbers,
      deposits,
      allValidFills,
      allRelayerRefunds,
      unfilledDeposits,
      allInvalidFills
    );
    const v3SpokeEventsReadable = prettyPrintV3SpokePoolEvents(
      bundleDepositsV3,
      bundleFillsV3,
      bundleInvalidFillsV3,
      bundleSlowFillsV3,
      expiredDepositsToRefundV3,
      unexecutableSlowFills
    );
    if (logData) {
      const mainnetRange = getBlockRangeForChain(
        blockRangesForChains,
        this.clients.hubPoolClient.chainId,
        this.chainIdListForBundleEvaluationBlockNumbers
      );
      this.logger.debug({
        at: "BundleDataClient#loadData",
        message: `Finished loading spoke pool data for the equivalent of mainnet range: [${mainnetRange[0]}, ${mainnetRange[1]}]`,
        blockRangesForChains,
        ...spokeEventsReadable,
      });
      this.logger.debug({
        at: "BundleDataClient#loadData",
        message: `Finished loading V3 spoke pool data for the equivalent of mainnet range: [${mainnetRange[0]}, ${mainnetRange[1]}]`,
        blockRangesForChains,
        ...v3SpokeEventsReadable,
      });
    }

    if (Object.keys(spokeEventsReadable.allInvalidFillsInRangeByDestinationChain).length > 0) {
      this.logger.debug({
        at: "BundleDataClient#loadData",
        message: "Finished loading spoke pool data and found some invalid fills in range",
        blockRangesForChains,
        allInvalidFillsInRangeByDestinationChain: spokeEventsReadable.allInvalidFillsInRangeByDestinationChain,
        allInvalidFills,
      });
    }

    // TODO: Create a pretty print for V3 events.
    if (bundleInvalidFillsV3.length > 0) {
      this.logger.debug({
        at: "BundleDataClient#loadData",
        message: "Finished loading V3 spoke pool data and found some invalid V3 fills in range",
        blockRangesForChains,
        bundleInvalidFillsV3,
      });
    }

    this.loadDataCache[key] = {
      fillsToRefund,
      deposits,
      unfilledDeposits,
      allValidFills,
      earlyDeposits,
      bundleDepositsV3,
      expiredDepositsToRefundV3,
      bundleFillsV3,
      unexecutableSlowFills,
      bundleSlowFillsV3,
    };

    return this.loadDataFromCache(key);
  }

  async getBundleBlockTimestamps(
    chainIds: number[],
    blockRangesForChains: number[][],
    spokePoolClients: SpokePoolClientsByChain
  ): Promise<{ [chainId: string]: number[] }> {
    return Object.fromEntries(
      await utils.mapAsync(chainIds, async (chainId, index) => {
        const spokePoolClient = spokePoolClients[chainId];
        const [_startBlockForChain, _endBlockForChain] = blockRangesForChains[index];
        // We can assume that in production
        // the block ranges passed into this function would never contain blocks where the the spoke pool client
        // hasn't queried. This is because this function will usually be called
        // in production with block ranges that were validated by
        // DataworkerUtils.blockRangesAreInvalidForSpokeClients
        const startBlockForChain = Math.min(_startBlockForChain, spokePoolClient.latestBlockSearched);
        const endBlockForChain = Math.min(_endBlockForChain, spokePoolClient.latestBlockSearched);
        return [
          chainId,
          [
            Number((await spokePoolClient.spokePool.provider.getBlock(startBlockForChain)).timestamp),
            Number((await spokePoolClient.spokePool.provider.getBlock(endBlockForChain)).timestamp),
          ],
        ];
      })
    );
  }
}

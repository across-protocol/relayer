import * as _ from "lodash";
import {
  ProposedRootBundle,
  SlowFillRequestWithBlock,
  SpokePoolClientsByChain,
  V3DepositWithBlock,
  V3FillWithBlock,
  FillType,
  FillStatus,
} from "../interfaces";
import { ConfigStoreClient, SpokePoolClient } from "../clients";
import {
  winston,
  BigNumber,
  bnZero,
  getRefundInformationFromFill,
  queryHistoricalDepositForFill,
  assign,
  assert,
  fixedPointAdjustment,
  isDefined,
  toBN,
} from "../utils";
import { Clients } from "../common";
import {
  getBlockRangeForChain,
  getImpliedBundleBlockRanges,
  getEndBlockBuffers,
  prettyPrintV3SpokePoolEvents,
  getRefundsFromBundle,
  CombinedRefunds,
  _buildPoolRebalanceRoot,
} from "../dataworker/DataworkerUtils";
import { getWidestPossibleExpectedBlockRange, isChainDisabled } from "../dataworker/PoolRebalanceUtils";
import { utils } from "@across-protocol/sdk";
import {
  BundleDepositsV3,
  BundleExcessSlowFills,
  BundleFillsV3,
  BundleFillV3,
  BundleSlowFills,
  ExpiredDepositsToRefundV3,
  LoadDataReturnValue,
} from "../interfaces/BundleData";
import { BundleDataSS } from "../utils/SuperstructUtils";
import { PoolRebalanceRoot } from "../dataworker/Dataworker";

type DataCache = Record<string, Promise<LoadDataReturnValue>>;

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
    refundObj.refunds ??= {};

    if (refundObj.refunds[fill.relayer]) {
      refundObj.refunds[fill.relayer] = refundObj.refunds[fill.relayer].add(refundAmount);
    } else {
      refundObj.refunds[fill.relayer] = refundAmount;
    }
  }
}

function updateBundleExcessSlowFills(
  dict: BundleExcessSlowFills,
  deposit: V3DepositWithBlock & { lpFeePct: BigNumber }
): void {
  const { destinationChainId, outputToken } = deposit;
  if (!dict?.[destinationChainId]?.[outputToken]) {
    assign(dict, [destinationChainId, outputToken], []);
  }
  dict[destinationChainId][outputToken].push(deposit);
}

function updateBundleSlowFills(dict: BundleSlowFills, deposit: V3DepositWithBlock & { lpFeePct: BigNumber }): void {
  const { destinationChainId, outputToken } = deposit;
  if (!dict?.[destinationChainId]?.[outputToken]) {
    assign(dict, [destinationChainId, outputToken], []);
  }
  dict[destinationChainId][outputToken].push(deposit);
}

// @notice Shared client for computing data needed to construct or validate a bundle.
export class BundleDataClient {
  private loadDataCache: DataCache = {};
  private arweaveDataCache: Record<string, Promise<LoadDataReturnValue>> = {};

  private bundleTimestampCache: Record<string, { [chainId: number]: number[] }> = {};

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

  private async loadDataFromCache(key: string): Promise<LoadDataReturnValue> {
    // Always return a deep cloned copy of object stored in cache. Since JS passes by reference instead of value, we
    // want to minimize the risk that the programmer accidentally mutates data in the cache.
    return _.cloneDeep(await this.loadDataCache[key]);
  }

  getBundleTimestampsFromCache(key: string): undefined | { [chainId: number]: number[] } {
    if (this.bundleTimestampCache[key]) {
      return _.cloneDeep(this.bundleTimestampCache[key]);
    }
    return undefined;
  }

  setBundleTimestampsInCache(key: string, timestamps: { [chainId: number]: number[] }): void {
    this.bundleTimestampCache[key] = timestamps;
  }

  private getArweaveClientKey(blockRangesForChains: number[][]): string {
    return `bundles-${blockRangesForChains}`;
  }

  private async loadPersistedDataFromArweave(
    blockRangesForChains: number[][]
  ): Promise<LoadDataReturnValue | undefined> {
    if (!isDefined(this.clients?.arweaveClient)) {
      return undefined;
    }
    const start = performance.now();
    const persistedData = await this.clients.arweaveClient.getByTopic(
      this.getArweaveClientKey(blockRangesForChains),
      BundleDataSS
    );
    // If there is no data or the data is empty, return undefined because we couldn't
    // pull info from the Arweave persistence layer.
    if (!isDefined(persistedData) || persistedData.length < 1) {
      return undefined;
    }

    // A converter function to account for the fact that our SuperStruct schema does not support numeric
    // keys in records. Fundamentally, this is a limitation of superstruct itself.
    const convertTypedStringRecordIntoNumericRecord = <UnderlyingType>(
      data: Record<string, Record<string, UnderlyingType>>
    ): Record<number, Record<string, UnderlyingType>> =>
      Object.keys(data).reduce((acc, chainId) => {
        acc[Number(chainId)] = data[chainId];
        return acc;
      }, {} as Record<number, Record<string, UnderlyingType>>);

    const data = persistedData[0].data;
    const bundleData = {
      bundleFillsV3: convertTypedStringRecordIntoNumericRecord(data.bundleFillsV3),
      expiredDepositsToRefundV3: convertTypedStringRecordIntoNumericRecord(data.expiredDepositsToRefundV3),
      bundleDepositsV3: convertTypedStringRecordIntoNumericRecord(data.bundleDepositsV3),
      unexecutableSlowFills: convertTypedStringRecordIntoNumericRecord(data.unexecutableSlowFills),
      bundleSlowFillsV3: convertTypedStringRecordIntoNumericRecord(data.bundleSlowFillsV3),
    };
    this.logger.debug({
      at: "BundleDataClient#loadPersistedDataFromArweave",
      message: `Loaded persisted data from Arweave in ${Math.round(performance.now() - start) / 1000}s.`,
      blockRanges: JSON.stringify(blockRangesForChains),
      bundleData: prettyPrintV3SpokePoolEvents(
        bundleData.bundleDepositsV3,
        bundleData.bundleFillsV3,
        [], // Invalid fills are not persisted to Arweave.
        bundleData.bundleSlowFillsV3,
        bundleData.expiredDepositsToRefundV3,
        bundleData.unexecutableSlowFills
      ),
    });
    return bundleData;
  }

  // @dev This function should probably be moved to the InventoryClient since it bypasses loadData completely now.
  async getPendingRefundsFromValidBundles(): Promise<CombinedRefunds[]> {
    const refunds = [];
    if (!this.clients.hubPoolClient.isUpdated) {
      throw new Error("BundleDataClient::getPendingRefundsFromValidBundles HubPoolClient not updated.");
    }

    const bundle = this.clients.hubPoolClient.getLatestFullyExecutedRootBundle(
      this.clients.hubPoolClient.latestBlockSearched
    );
    if (bundle !== undefined) {
      refunds.push(await this.getPendingRefundsFromBundle(bundle));
    } // No more valid bundles in history!
    return refunds;
  }

  // @dev This function should probably be moved to the InventoryClient since it bypasses loadData completely now.
  // Return refunds from input bundle.
  async getPendingRefundsFromBundle(bundle: ProposedRootBundle): Promise<CombinedRefunds> {
    const nextBundleMainnetStartBlock = this.clients.hubPoolClient.getNextBundleStartBlockNumber(
      this.chainIdListForBundleEvaluationBlockNumbers,
      this.clients.hubPoolClient.latestBlockSearched,
      this.clients.hubPoolClient.chainId
    );
    const chainIds = this.clients.configStoreClient.getChainIdIndicesForBlock(nextBundleMainnetStartBlock);

    // Reconstruct latest bundle block range.
    const bundleEvaluationBlockRanges = getImpliedBundleBlockRanges(
      this.clients.hubPoolClient,
      this.clients.configStoreClient,
      bundle
    );
    let combinedRefunds: CombinedRefunds;
    // Here we don't call loadData because our fallback is to approximate refunds if we don't have arweave data, rather
    // than use the much slower loadData to compute all refunds. We don't need to consider slow fills or deposit
    // expiries here so we can skip some steps. We also don't need to compute LP fees as they should be small enough
    // so as not to affect this approximate refund count.
    const arweaveData = await this.loadArweaveData(bundleEvaluationBlockRanges);
    if (arweaveData === undefined) {
      combinedRefunds = this.getApproximateRefundsForBlockRange(chainIds, bundleEvaluationBlockRanges);
    } else {
      const { bundleFillsV3, expiredDepositsToRefundV3 } = arweaveData;
      combinedRefunds = getRefundsFromBundle(bundleFillsV3, expiredDepositsToRefundV3);
      // If we don't have a spoke pool client for a chain, then we won't be able to deduct refunds correctly for this
      // chain. For most of the pending bundle's liveness period, these past refunds are already executed so this is
      // a reasonable assumption. This empty refund chain also matches what the alternative
      // `getApproximateRefundsForBlockRange` would return.
      Object.keys(combinedRefunds).forEach((chainId) => {
        if (this.spokePoolClients[Number(chainId)] === undefined) {
          delete combinedRefunds[Number(chainId)];
        }
      });
    }

    // The latest proposed bundle's refund leaves might have already been partially or entirely executed.
    // We have to deduct the executed amounts from the total refund amounts.
    return this.deductExecutedRefunds(combinedRefunds, bundle);
  }

  // @dev This helper function should probably be moved to the InventoryClient
  getApproximateRefundsForBlockRange(chainIds: number[], blockRanges: number[][]): CombinedRefunds {
    const refundsForChain: CombinedRefunds = {};
    for (const chainId of chainIds) {
      if (this.spokePoolClients[chainId] === undefined) {
        continue;
      }
      const chainIndex = chainIds.indexOf(chainId);
      this.spokePoolClients[chainId]
        .getFills()
        .filter((fill) => {
          if (fill.blockNumber < blockRanges[chainIndex][0] || fill.blockNumber > blockRanges[chainIndex][1]) {
            return false;
          }

          // If origin spoke pool client isn't defined, we can't validate it.
          if (this.spokePoolClients[fill.originChainId] === undefined) {
            return false;
          }
          const matchingDeposit = this.spokePoolClients[fill.originChainId].getDeposit(fill.depositId);
          const hasMatchingDeposit =
            matchingDeposit !== undefined &&
            this.getRelayHashFromEvent(fill) === this.getRelayHashFromEvent(matchingDeposit);
          return hasMatchingDeposit;
        })
        .forEach((fill) => {
          const matchingDeposit = this.spokePoolClients[fill.originChainId].getDeposit(fill.depositId);
          assert(isDefined(matchingDeposit));
          const { chainToSendRefundTo, repaymentToken } = getRefundInformationFromFill(
            fill,
            this.clients.hubPoolClient,
            blockRanges,
            this.chainIdListForBundleEvaluationBlockNumbers,
            matchingDeposit.fromLiteChain
          );
          // Assume that lp fees are 0 for the sake of speed. In the future we could batch compute
          // these or make hardcoded assumptions based on the origin-repayment chain direction. This might result
          // in slight over estimations of refunds, but its not clear whether underestimating or overestimating is
          // worst from the relayer's perspective.
          const { relayer, inputAmount: refundAmount } = fill;
          refundsForChain[chainToSendRefundTo] ??= {};
          refundsForChain[chainToSendRefundTo][repaymentToken] ??= {};
          const existingRefundAmount = refundsForChain[chainToSendRefundTo][repaymentToken][relayer] ?? bnZero;
          refundsForChain[chainToSendRefundTo][repaymentToken][relayer] = existingRefundAmount.add(refundAmount);
        });
    }
    return refundsForChain;
  }

  getUpcomingDepositAmount(chainId: number, l2Token: string, latestBlockToSearch: number): BigNumber {
    if (this.spokePoolClients[chainId] === undefined) {
      return toBN(0);
    }
    return this.spokePoolClients[chainId]
      .getDeposits()
      .filter((deposit) => deposit.blockNumber > latestBlockToSearch && deposit.inputToken === l2Token)
      .reduce((acc, deposit) => {
        return acc.add(deposit.inputAmount);
      }, toBN(0));
  }

  private async getLatestProposedBundleData(): Promise<{ bundleData: LoadDataReturnValue; blockRanges: number[][] }> {
    const hubPoolClient = this.clients.hubPoolClient;
    // Determine which bundle we should fetch from arweave, either the pending bundle or the latest
    // executed one. Both should have arweave data but if for some reason the arweave data is missing,
    // this function will have to compute the bundle data from scratch which will be slow. We have to fallback
    // to computing the bundle from scratch since this function needs to return the full bundle data so that
    // it can be used to get the running balance proposed using its data.
    const bundleBlockRanges = getImpliedBundleBlockRanges(
      hubPoolClient,
      this.clients.configStoreClient,
      hubPoolClient.hasPendingProposal()
        ? hubPoolClient.getLatestProposedRootBundle()
        : hubPoolClient.getLatestFullyExecutedRootBundle(hubPoolClient.latestBlockSearched)
    );
    return {
      blockRanges: bundleBlockRanges,
      bundleData: await this.loadData(
        bundleBlockRanges,
        this.spokePoolClients,
        true // this bundle data should have been published to arweave
      ),
    };
  }

  async getLatestPoolRebalanceRoot(): Promise<{ root: PoolRebalanceRoot; blockRanges: number[][] }> {
    const { bundleData, blockRanges } = await this.getLatestProposedBundleData();
    const hubPoolClient = this.clients.hubPoolClient;
    const root = await _buildPoolRebalanceRoot(
      hubPoolClient.latestBlockSearched,
      blockRanges[0][1],
      bundleData.bundleDepositsV3,
      bundleData.bundleFillsV3,
      bundleData.bundleSlowFillsV3,
      bundleData.unexecutableSlowFills,
      bundleData.expiredDepositsToRefundV3,
      {
        hubPoolClient,
        configStoreClient: hubPoolClient.configStoreClient as ConfigStoreClient,
      }
    );
    return {
      root,
      blockRanges,
    };
  }

  // @dev This function should probably be moved to the InventoryClient since it bypasses loadData completely now.
  // Return refunds from the next valid bundle. This will contain any refunds that have been sent but are not included
  // in a valid bundle with all of its leaves executed. This contains refunds from:
  // - Bundles that passed liveness but have not had all of their pool rebalance leaves executed.
  // - Bundles that are pending liveness
  // - Fills sent after the pending, but not validated, bundle
  async getNextBundleRefunds(): Promise<CombinedRefunds[]> {
    const hubPoolClient = this.clients.hubPoolClient;
    const nextBundleMainnetStartBlock = hubPoolClient.getNextBundleStartBlockNumber(
      this.chainIdListForBundleEvaluationBlockNumbers,
      hubPoolClient.latestBlockSearched,
      hubPoolClient.chainId
    );
    const chainIds = this.clients.configStoreClient.getChainIdIndicesForBlock(nextBundleMainnetStartBlock);
    const combinedRefunds: CombinedRefunds[] = [];

    // @dev: If spoke pool client is undefined for a chain, then the end block will be null or undefined, which
    // should be handled gracefully and effectively cause this function to ignore refunds for the chain.
    let widestBundleBlockRanges = getWidestPossibleExpectedBlockRange(
      chainIds,
      this.spokePoolClients,
      getEndBlockBuffers(chainIds, this.blockRangeEndBlockBuffer),
      this.clients,
      this.clients.hubPoolClient.latestBlockSearched,
      this.clients.configStoreClient.getEnabledChains(this.clients.hubPoolClient.latestBlockSearched)
    );
    // Return block ranges for blocks after _pendingBlockRanges and up to widestBlockRanges.
    // If a chain is disabled or doesn't have a spoke pool client, return a range of 0
    function getBlockRangeDelta(_pendingBlockRanges: number[][]): number[][] {
      return widestBundleBlockRanges.map((blockRange, index) => {
        // If pending block range doesn't have an entry for the widest range, which is possible when a new chain
        // is added to the CHAIN_ID_INDICES list, then simply set the initial block range to the widest block range.
        // This will produce a block range delta of 0 where the returned range for this chain is [widest[1], widest[1]].
        const initialBlockRange = _pendingBlockRanges[index] ?? blockRange;
        // If chain is disabled, return disabled range
        if (initialBlockRange[0] === initialBlockRange[1]) {
          return initialBlockRange;
        }
        // If pending bundle end block exceeds widest end block or if widest end block is undefined
        // (which is possible if the spoke pool client for the chain is not defined), return an empty range since there are no
        // "new" events to consider for this chain.
        if (!isDefined(blockRange[1]) || initialBlockRange[1] >= blockRange[1]) {
          return [initialBlockRange[1], initialBlockRange[1]];
        }
        // If initialBlockRange][0] > widestBlockRange[0], then we'll ignore any blocks
        // between initialBlockRange[0] and widestBlockRange[0] (inclusive) for simplicity reasons. In practice
        // this should not happen.
        return [initialBlockRange[1] + 1, blockRange[1]];
      });
    }

    // If there is a pending bundle that has not been fully executed, then it should have arweave
    // data so we can load it from there.
    if (hubPoolClient.hasPendingProposal()) {
      const pendingBundleBlockRanges = getImpliedBundleBlockRanges(
        hubPoolClient,
        this.clients.configStoreClient,
        hubPoolClient.getLatestProposedRootBundle()
      );
      // Similar to getAppoximateRefundsForBlockRange, we'll skip the full bundle reconstruction if the arweave
      // data is undefined and use the much faster approximation method which doesn't consider LP fees which is
      // ok for this use case.
      const arweaveData = await this.loadArweaveData(pendingBundleBlockRanges);
      if (arweaveData === undefined) {
        combinedRefunds.push(this.getApproximateRefundsForBlockRange(chainIds, pendingBundleBlockRanges));
      } else {
        const { bundleFillsV3, expiredDepositsToRefundV3 } = arweaveData;
        combinedRefunds.push(getRefundsFromBundle(bundleFillsV3, expiredDepositsToRefundV3));
      }

      // Shorten the widestBundleBlockRanges now to not double count the pending bundle blocks.
      widestBundleBlockRanges = getBlockRangeDelta(pendingBundleBlockRanges);
    }

    // Next, load all refunds sent after the last bundle proposal. This can be expensive so we'll skip the full
    // bundle reconstruction and make some simplifying assumptions:
    // - Only look up fills sent after the pending bundle's end blocks
    // - Skip LP fee computations and just assume the relayer is being refunded the full deposit.inputAmount
    const start = performance.now();
    combinedRefunds.push(this.getApproximateRefundsForBlockRange(chainIds, widestBundleBlockRanges));
    this.logger.debug({
      at: "BundleDataClient#getNextBundleRefunds",
      message: `Loading approximate refunds for next bundle in ${Math.round(performance.now() - start) / 1000}s.`,
      blockRanges: JSON.stringify(widestBundleBlockRanges),
    });
    return combinedRefunds;
  }

  // @dev This helper function should probably be moved to the InventoryClient
  getExecutedRefunds(
    spokePoolClient: SpokePoolClient,
    relayerRefundRoot: string
  ): {
    [tokenAddress: string]: {
      [relayer: string]: BigNumber;
    };
  } {
    if (!isDefined(spokePoolClient)) {
      return {};
    }
    // @dev Search from right to left since there can be multiple root bundles with the same relayer refund root.
    // The caller should take caution if they're trying to use this function to find matching refunds for older
    // root bundles as opposed to more recent ones.
    const bundle = _.findLast(
      spokePoolClient.getRootBundleRelays(),
      (bundle) => bundle.relayerRefundRoot === relayerRefundRoot
    );
    if (bundle === undefined) {
      return {};
    }

    const executedRefundLeaves = spokePoolClient
      .getRelayerRefundExecutions()
      .filter((leaf) => leaf.rootBundleId === bundle.rootBundleId);
    const executedRefunds: { [tokenAddress: string]: { [relayer: string]: BigNumber } } = {};
    for (const refundLeaf of executedRefundLeaves) {
      const tokenAddress = refundLeaf.l2TokenAddress;
      if (executedRefunds[tokenAddress] === undefined) {
        executedRefunds[tokenAddress] = {};
      }
      const executedTokenRefunds = executedRefunds[tokenAddress];

      for (let i = 0; i < refundLeaf.refundAddresses.length; i++) {
        const relayer = refundLeaf.refundAddresses[i];
        const refundAmount = refundLeaf.refundAmounts[i];
        if (executedTokenRefunds[relayer] === undefined) {
          executedTokenRefunds[relayer] = bnZero;
        }
        executedTokenRefunds[relayer] = executedTokenRefunds[relayer].add(refundAmount);
      }
    }
    return executedRefunds;
  }

  // @dev This helper function should probably be moved to the InventoryClient
  private deductExecutedRefunds(
    allRefunds: CombinedRefunds,
    bundleContainingRefunds: ProposedRootBundle
  ): CombinedRefunds {
    for (const chainIdStr of Object.keys(allRefunds)) {
      const chainId = Number(chainIdStr);
      if (!isDefined(this.spokePoolClients[chainId])) {
        continue;
      }
      const executedRefunds = this.getExecutedRefunds(
        this.spokePoolClients[chainId],
        bundleContainingRefunds.relayerRefundRoot
      );

      for (const tokenAddress of Object.keys(allRefunds[chainId])) {
        const refunds = allRefunds[chainId][tokenAddress];
        if (executedRefunds[tokenAddress] === undefined || refunds === undefined) {
          continue;
        }

        for (const relayer of Object.keys(refunds)) {
          const executedAmount = executedRefunds[tokenAddress][relayer];
          if (executedAmount === undefined) {
            continue;
          }
          // Since there should only be a single executed relayer refund leaf for each relayer-token-chain combination,
          // we can deduct this refund and mark it as executed if the executed amount is > 0.
          refunds[relayer] = bnZero;
        }
      }
    }
    return allRefunds;
  }

  getRefundsFor(bundleRefunds: CombinedRefunds, relayer: string, chainId: number, token: string): BigNumber {
    if (!bundleRefunds[chainId] || !bundleRefunds[chainId][token]) {
      return BigNumber.from(0);
    }
    const allRefunds = bundleRefunds[chainId][token];
    return allRefunds && allRefunds[relayer] ? allRefunds[relayer] : BigNumber.from(0);
  }

  getTotalRefund(refunds: CombinedRefunds[], relayer: string, chainId: number, refundToken: string): BigNumber {
    return refunds.reduce((totalRefund, refunds) => {
      return totalRefund.add(this.getRefundsFor(refunds, relayer, chainId, refundToken));
    }, bnZero);
  }

  private async loadArweaveData(blockRangesForChains: number[][]): Promise<LoadDataReturnValue> {
    const arweaveKey = this.getArweaveClientKey(blockRangesForChains);
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    if (!this.arweaveDataCache[arweaveKey]) {
      this.arweaveDataCache[arweaveKey] = this.loadPersistedDataFromArweave(blockRangesForChains);
    }
    const arweaveData = _.cloneDeep(await this.arweaveDataCache[arweaveKey]);
    return arweaveData;
  }

  // Common data re-formatting logic shared across all data worker public functions.
  // User must pass in spoke pool to search event data against. This allows the user to refund relays and fill deposits
  // on deprecated spoke pools.
  async loadData(
    blockRangesForChains: number[][],
    spokePoolClients: SpokePoolClientsByChain,
    attemptArweaveLoad = false
  ): Promise<LoadDataReturnValue> {
    const key = JSON.stringify(blockRangesForChains);
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    if (!this.loadDataCache[key]) {
      let arweaveData;
      if (attemptArweaveLoad) {
        arweaveData = await this.loadArweaveData(blockRangesForChains);
      } else {
        arweaveData = undefined;
      }
      const data = isDefined(arweaveData)
        ? // We can return the data to a Promise to keep the return type consistent.
          // Note: this is now a fast operation since we've already loaded the data from Arweave.
          Promise.resolve(arweaveData)
        : this.loadDataFromScratch(blockRangesForChains, spokePoolClients);
      this.loadDataCache[key] = data;
    }

    return this.loadDataFromCache(key);
  }

  private async loadDataFromScratch(
    blockRangesForChains: number[][],
    spokePoolClients: SpokePoolClientsByChain
  ): Promise<LoadDataReturnValue> {
    let start = performance.now();
    const key = JSON.stringify(blockRangesForChains);

    if (!this.clients.configStoreClient.isUpdated) {
      throw new Error("ConfigStoreClient not updated");
    } else if (!this.clients.hubPoolClient.isUpdated) {
      throw new Error("HubPoolClient not updated");
    }

    const chainIds = this.clients.configStoreClient.getChainIdIndicesForBlock(blockRangesForChains[0][0]);

    if (blockRangesForChains.length > chainIds.length) {
      throw new Error(
        `Unexpected block range list length of ${blockRangesForChains.length}, should be <= ${chainIds.length}`
      );
    }

    // V3 specific objects:
    const bundleDepositsV3: BundleDepositsV3 = {}; // Deposits in bundle block range.
    const bundleFillsV3: BundleFillsV3 = {}; // Fills to refund in bundle block range.
    const bundleInvalidFillsV3: V3FillWithBlock[] = []; // Fills that are not valid in this bundle.
    const bundleSlowFillsV3: BundleSlowFills = {}; // Deposits that we need to send slow fills
    // for in this bundle.
    const expiredDepositsToRefundV3: ExpiredDepositsToRefundV3 = {};
    // Newly expired deposits in this bundle that need to be refunded.
    const unexecutableSlowFills: BundleExcessSlowFills = {};
    // Deposit data for all Slowfills that was included in a previous
    // bundle and can no longer be executed because (1) they were replaced with a FastFill in this bundle or
    // (2) the fill deadline has passed. We'll need to decrement running balances for these deposits on the
    // destination chain where the slow fill would have been executed.

    const _isChainDisabled = (chainId: number): boolean => {
      const blockRangeForChain = getBlockRangeForChain(blockRangesForChains, chainId, chainIds);
      return isChainDisabled(blockRangeForChain);
    };

    // Infer chain ID's to load from number of block ranges passed in.
    const allChainIds = blockRangesForChains
      .map((_blockRange, index) => chainIds[index])
      .filter((chainId) => !_isChainDisabled(chainId) && spokePoolClients[chainId] !== undefined);
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
    const _cachedBundleTimestamps = this.getBundleTimestampsFromCache(key);
    let bundleBlockTimestamps: { [chainId: string]: number[] } = {};
    if (!_cachedBundleTimestamps) {
      bundleBlockTimestamps = await this.getBundleBlockTimestamps(chainIds, blockRangesForChains, spokePoolClients);
      this.setBundleTimestampsInCache(key, bundleBlockTimestamps);
      this.logger.debug({
        at: "BundleDataClient#loadData",
        message: "Bundle block timestamps",
        bundleBlockTimestamps,
        blockRangesForChains: JSON.stringify(blockRangesForChains),
      });
    } else {
      bundleBlockTimestamps = _cachedBundleTimestamps;
    }

    /** *****************************
     *
     * Handle V3 events
     *
     * *****************************/

    // The methodology here is roughly as follows
    // - Query all deposits from SpokePoolClients
    //  - If deposit is in origin chain block range, add it to bundleDepositsV3
    //  - If deposit is expired or from an older bundle, stash it away as a deposit that may require an expired
    //    deposit refund.
    // - Query fills from SpokePoolClients
    //  - If fill is in destination chain block range, then validate fill
    //  - Fill is valid if its RelayData hash is identical to a deposit's relay data hash that we've already seen.
    //    If we haven't seen a deposit with a matching hash, then we need to query for an older deposit earlier than
    //    the SpokePoolClient's lookback window via queryHistoricalDepositForFill().
    //  - If fill is valid, then add it to bundleFillsV3. If it's a slow fill execution, we won't
    //    add a relayer refund for it, but all fills accumulate realized LP fees.
    //    - If fill replaced a slow fill request, then stash it away as one that potentially created an
    //      unexecutable slow fill.
    // - Query slow fills from SpokePoolClients
    //  - If slow fill is in destination chain block range, then validate slow fill
    //  - Slow fill is valid if its RelayData hash is identical to a deposit's relay data hash that we've already seen,
    //    and it does not match with a Fill that we've seen, and its input and output tokens are equivalent,
    //    and the deposit that is being slow filled has not expired.
    //   - Note that if we haven't can't match the slow fill with a deposit, then we need to query for an older
    //     deposit earlier than the SpokePoolClient's lookback window via queryHistoricalDepositForFill().
    //   - input and output tokens are considered equivalent if they map to the same L1 token via a PoolRebalanceRoute
    //     at the deposit.quoteBlockNumber.
    // - To validate fills that replaced slow fills, we should check that there is no slow fill request in the
    //   current destination chain bundle block range with a matching relay hash. Additionally, the
    //   fast fill replacing a slow fill must have filled a slow-fill eligible deposit meaning that
    //   its input and output tokens are equivalent. We don't need to check that the slow fill was created
    //   before the deposit expired by definition because the deposit was fast-filled, meaning that it did not
    //   expire.
    // - To validate deposits in the current bundle block range that expired newly in this destination
    //   chain's current bundle block range, we only have to check that the deposit was not filled in the current
    //   destination chain block range.
    // - To validate deposits from a prior bundle that expired newly, we need to make sure that the deposit
    //   was not filled. If we can't find a fill, then we should check its FillStatus on-chain via eth_call.
    //   This will return either Unfilled, RequestedSlowFill, or Filled. If the deposit is Filled, then
    //   then the fill happened a long time ago and we should do nothing. If the deposit is Unfilled, then
    //   we should refund it as an expired deposit. If the deposit is RequestedSlowFill then we need to validate
    //   that the deposit is eligible for a slow fill (its input and output tokens are equivalent) and that
    //   the slow fill request was not sent in the current destination chain's bundle block range.

    // Using the above rules, we will create a list of:
    // - deposits in the current bundle
    // - fast fills to refund in the current bundle
    // - fills creating bundle LP fees in the current bundle
    // - slow fills to create for the current bundle
    // - deposits that expired in the current bundle

    // Use this dictionary to conveniently unite all events with the same relay data hash which will make
    // secondary lookups faster. The goal is to lazily fill up this dictionary with all events in the SpokePool
    // client's in-memory event cache.
    const v3RelayHashes: {
      [relayHash: string]: {
        // Note: Since there are no partial fills in v3, there should only be one fill per relay hash.
        // There should also only be one deposit per relay hash since deposit ID's can't be re-used on the
        // same spoke pool. Moreover, the SpokePool blocks multiple slow fill requests, so
        // there should also only be one slow fill request per relay hash.
        deposit?: V3DepositWithBlock;
        fill?: V3FillWithBlock;
        slowFillRequest?: SlowFillRequestWithBlock;
      };
    } = {};

    // Process all deposits first and keep track of deposits that may be refunded as an expired deposit:
    // - expiredBundleDepositHashes: Deposits sent in this bundle that expired.
    const expiredBundleDepositHashes: Set<string> = new Set<string>();
    // - olderDepositHashes: Deposits sent in a prior bundle that newly expired in this bundle
    const olderDepositHashes: Set<string> = new Set<string>();

    let depositCounter = 0;
    for (const originChainId of allChainIds) {
      const originClient = spokePoolClients[originChainId];
      const originChainBlockRange = getBlockRangeForChain(blockRangesForChains, originChainId, chainIds);

      for (const destinationChainId of allChainIds) {
        if (originChainId === destinationChainId) {
          continue;
        }

        originClient
          .getDepositsForDestinationChain(destinationChainId)
          .filter((deposit) => deposit.blockNumber <= originChainBlockRange[1])
          .forEach((deposit) => {
            depositCounter++;
            const relayDataHash = this.getRelayHashFromEvent(deposit);
            if (v3RelayHashes[relayDataHash]) {
              // If we've seen this deposit before, then skip this deposit. This can happen if our RPC provider
              // gives us bad data.
              return;
            }
            // Even if deposit is not in bundle block range, store all deposits we can see in memory in this
            // convenient dictionary.
            v3RelayHashes[relayDataHash] = {
              deposit: deposit,
              fill: undefined,
              slowFillRequest: undefined,
            };

            // If deposit block is within origin chain bundle block range, then save as bundle deposit.
            // If deposit is in bundle and it has expired, additionally save it as an expired deposit.
            // If deposit is not in the bundle block range, then save it as an older deposit that
            // may have expired.
            if (deposit.blockNumber >= originChainBlockRange[0]) {
              // Deposit is a V3 deposit in this origin chain's bundle block range and is not a duplicate.
              updateBundleDepositsV3(bundleDepositsV3, deposit);
              // We don't check that fillDeadline >= bundleBlockTimestamps[destinationChainId][0] because
              // that would eliminate any deposits in this bundle with a very low fillDeadline like equal to 0
              // for example. Those should be impossible to create but technically should be included in this
              // bundle of refunded deposits.
              if (deposit.fillDeadline < bundleBlockTimestamps[destinationChainId][1]) {
                expiredBundleDepositHashes.add(relayDataHash);
              }
            } else {
              olderDepositHashes.add(relayDataHash);
            }
          });
      }
    }
    this.logger.debug({
      at: "BundleDataClient#loadData",
      message: `Processed ${depositCounter} deposits in ${performance.now() - start}ms.`,
    });
    start = performance.now();

    // Process fills now that we've populated relay hash dictionary with deposits:
    const validatedBundleV3Fills: (V3FillWithBlock & { quoteTimestamp: number })[] = [];
    const validatedBundleSlowFills: V3DepositWithBlock[] = [];
    const validatedBundleUnexecutableSlowFills: V3DepositWithBlock[] = [];
    let fillCounter = 0;
    for (const originChainId of allChainIds) {
      const originClient = spokePoolClients[originChainId];
      for (const destinationChainId of allChainIds) {
        if (originChainId === destinationChainId) {
          continue;
        }

        const destinationClient = spokePoolClients[destinationChainId];
        const destinationChainBlockRange = getBlockRangeForChain(blockRangesForChains, destinationChainId, chainIds);

        // Keep track of fast fills that replaced slow fills, which we'll use to create "unexecutable" slow fills
        // if the slow fill request was sent in a prior bundle.
        const fastFillsReplacingSlowFills: string[] = [];
        await utils.forEachAsync(
          destinationClient
            .getFillsForOriginChain(originChainId)
            .filter((fill) => fill.blockNumber <= destinationChainBlockRange[1]),
          async (fill) => {
            const relayDataHash = this.getRelayHashFromEvent(fill);
            fillCounter++;

            if (v3RelayHashes[relayDataHash]) {
              if (!v3RelayHashes[relayDataHash].fill) {
                assert(v3RelayHashes[relayDataHash].deposit, "Deposit should exist in relay hash dictionary.");
                // At this point, the v3RelayHashes entry already existed meaning that there is a matching deposit,
                // so this fill is validated.
                v3RelayHashes[relayDataHash].fill = fill;
                if (fill.blockNumber >= destinationChainBlockRange[0]) {
                  validatedBundleV3Fills.push({
                    ...fill,
                    quoteTimestamp: v3RelayHashes[relayDataHash].deposit.quoteTimestamp,
                  });
                  // If fill replaced a slow fill request, then mark it as one that might have created an
                  // unexecutable slow fill. We can't know for sure until we check the slow fill request
                  // events.
                  if (fill.relayExecutionInfo.fillType === FillType.ReplacedSlowFill) {
                    fastFillsReplacingSlowFills.push(relayDataHash);
                  }
                }
              }
              return;
            }

            // At this point, there is no relay hash dictionary entry for this fill, so we need to
            // instantiate the entry.
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
            if (fill.blockNumber >= destinationChainBlockRange[0]) {
              const historicalDeposit = await queryHistoricalDepositForFill(originClient, fill);
              if (!historicalDeposit.found) {
                bundleInvalidFillsV3.push(fill);
              } else {
                const matchedDeposit = historicalDeposit.deposit;
                // @dev Since queryHistoricalDepositForFill validates the fill by checking individual
                // object property values against the deposit's, we
                // sanity check it here by comparing the full relay hashes. If there's an error here then the
                // historical deposit query is not working as expected.
                assert(this.getRelayHashFromEvent(matchedDeposit) === relayDataHash);
                validatedBundleV3Fills.push({
                  ...fill,
                  quoteTimestamp: matchedDeposit.quoteTimestamp,
                });
                v3RelayHashes[relayDataHash].deposit = matchedDeposit;
                if (fill.relayExecutionInfo.fillType === FillType.ReplacedSlowFill) {
                  fastFillsReplacingSlowFills.push(relayDataHash);
                }
              }
            }
          }
        );

        await utils.forEachAsync(
          destinationClient
            .getSlowFillRequestsForOriginChain(originChainId)
            .filter((request) => request.blockNumber <= destinationChainBlockRange[1]),
          async (slowFillRequest: SlowFillRequestWithBlock) => {
            const relayDataHash = this.getRelayHashFromEvent(slowFillRequest);

            if (v3RelayHashes[relayDataHash]) {
              if (!v3RelayHashes[relayDataHash].slowFillRequest) {
                // At this point, the v3RelayHashes entry already existed meaning that there is either a matching
                // fill or deposit.
                v3RelayHashes[relayDataHash].slowFillRequest = slowFillRequest;
                if (v3RelayHashes[relayDataHash].fill) {
                  // If there is a fill matching the relay hash, then this slow fill request can't be used
                  // to create a slow fill for a filled deposit.
                  return;
                }
                assert(v3RelayHashes[relayDataHash].deposit, "Deposit should exist in relay hash dictionary.");
                const matchedDeposit = v3RelayHashes[relayDataHash].deposit;

                // Input and Output tokens must be equivalent on the deposit for this to be slow filled.
                if (
                  !this.clients.hubPoolClient.areTokensEquivalent(
                    matchedDeposit.inputToken,
                    matchedDeposit.originChainId,
                    matchedDeposit.outputToken,
                    matchedDeposit.destinationChainId,
                    matchedDeposit.quoteBlockNumber
                  )
                ) {
                  return;
                }

                // slow fill requests for deposits from or to lite chains are considered invalid
                if (
                  v3RelayHashes[relayDataHash].deposit.fromLiteChain ||
                  v3RelayHashes[relayDataHash].deposit.toLiteChain
                ) {
                  return;
                }

                // If there is no fill matching the relay hash, then this might be a valid slow fill request
                // that we should produce a slow fill leaf for. Check if the slow fill request is in the
                // destination chain block range and that the underlying deposit has not expired yet.
                if (
                  slowFillRequest.blockNumber >= destinationChainBlockRange[0] &&
                  // Deposit must not have expired in this bundle.
                  slowFillRequest.fillDeadline >= bundleBlockTimestamps[destinationChainId][1]
                ) {
                  // At this point, the v3RelayHashes entry already existed meaning that there is a matching deposit,
                  // so this slow fill request relay data is correct.
                  validatedBundleSlowFills.push(matchedDeposit);
                }
              }
              return;
            }

            // Instantiate dictionary if there is neither a deposit nor fill matching it.
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
            if (slowFillRequest.blockNumber >= destinationChainBlockRange[0]) {
              const historicalDeposit = await queryHistoricalDepositForFill(originClient, slowFillRequest);
              if (!historicalDeposit.found) {
                // TODO: Invalid slow fill request. Maybe worth logging.
                return;
              }
              const matchedDeposit: V3DepositWithBlock = historicalDeposit.deposit;
              // @dev Since queryHistoricalDepositForFill validates the slow fill request by checking individual
              // object property values against the deposit's, we
              // sanity check it here by comparing the full relay hashes. If there's an error here then the
              // historical deposit query is not working as expected.
              assert(this.getRelayHashFromEvent(matchedDeposit) === relayDataHash);

              // slow fill requests for deposits from or to lite chains are considered invalid
              if (matchedDeposit.fromLiteChain || matchedDeposit.toLiteChain) {
                return;
              }

              v3RelayHashes[relayDataHash].deposit = matchedDeposit;

              // Note: we don't need to query for a historical fill at this point because a fill
              // cannot precede a slow fill request and if the fill came after the slow fill request,
              // we would have seen it already because we would have processed it in the loop above.
              if (
                // Input and Output tokens must be equivalent on the deposit for this to be slow filled.
                !this.clients.hubPoolClient.areTokensEquivalent(
                  matchedDeposit.inputToken,
                  matchedDeposit.originChainId,
                  matchedDeposit.outputToken,
                  matchedDeposit.destinationChainId,
                  matchedDeposit.quoteBlockNumber
                ) ||
                // Deposit must not have expired in this bundle.
                slowFillRequest.fillDeadline < bundleBlockTimestamps[destinationChainId][1]
              ) {
                // TODO: Invalid slow fill request. Maybe worth logging.
                return;
              }
              validatedBundleSlowFills.push(matchedDeposit);
            }
          }
        );

        // For all fills that came after a slow fill request, we can now check if the slow fill request
        // was a valid one and whether it was created in a previous bundle. If so, then it created a slow fill
        // leaf that is now unexecutable.
        fastFillsReplacingSlowFills.forEach((relayDataHash) => {
          const { deposit, slowFillRequest, fill } = v3RelayHashes[relayDataHash];
          assert(
            fill.relayExecutionInfo.fillType === FillType.ReplacedSlowFill,
            "Fill type should be ReplacedSlowFill."
          );
          const destinationBlockRange = getBlockRangeForChain(blockRangesForChains, destinationChainId, chainIds);
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
            validatedBundleUnexecutableSlowFills.push(deposit);
          }
        });
      }
    }
    this.logger.debug({
      at: "BundleDataClient#loadData",
      message: `Processed ${fillCounter} fills in ${performance.now() - start}ms.`,
    });
    start = performance.now();

    // Go through expired deposits in this bundle and now prune those that we have seen a fill for to construct
    // the list of expired deposits we need to refund in this bundle.
    expiredBundleDepositHashes.forEach((relayDataHash) => {
      const { deposit, fill } = v3RelayHashes[relayDataHash];
      assert(deposit, "Deposit should exist in relay hash dictionary.");
      if (!fill) {
        updateExpiredDepositsV3(expiredDepositsToRefundV3, deposit);
      }
    });

    // For all deposits older than this bundle, we need to check if they expired in this bundle and if they did,
    // whether there was a slow fill created for it in a previous bundle that is now unexecutable and replaced
    // by a new expired deposit refund.
    await utils.forEachAsync([...olderDepositHashes], async (relayDataHash) => {
      const { deposit, slowFillRequest, fill } = v3RelayHashes[relayDataHash];
      assert(deposit, "Deposit should exist in relay hash dictionary.");
      const { destinationChainId } = deposit;
      const destinationBlockRange = getBlockRangeForChain(blockRangesForChains, destinationChainId, chainIds);

      // Only look for deposits that were mined before this bundle and that are newly expired.
      // If the fill deadline is lower than the bundle start block on the destination chain, then
      // we should assume it was marked "newly expired" and refunded in a previous bundle.
      if (
        // If there is a valid fill that we saw matching this deposit, then it does not need a refund.
        !fill &&
        deposit.fillDeadline < bundleBlockTimestamps[destinationChainId][1] &&
        deposit.fillDeadline >= bundleBlockTimestamps[destinationChainId][0] &&
        spokePoolClients[destinationChainId] !== undefined
      ) {
        // If we haven't seen a fill matching this deposit, then we need to rule out that it was filled a long time ago
        // by checkings its on-chain fill status.
        const fillStatus = await utils.relayFillStatus(
          spokePoolClients[destinationChainId].spokePool,
          deposit,
          // We can assume that in production
          // the block ranges passed into this function would never contain blocks where the spoke pool client
          // hasn't queried. This is because this function will usually be called
          // in production with block ranges that were validated by
          // DataworkerUtils.blockRangesAreInvalidForSpokeClients
          Math.min(destinationBlockRange[1], spokePoolClients[destinationChainId].latestBlockSearched),
          destinationChainId
        );

        // If there is no matching fill and the deposit expired in this bundle and the fill status on-chain is not
        // Filled, then we can to refund it as an expired deposit.
        if (fillStatus !== FillStatus.Filled) {
          updateExpiredDepositsV3(expiredDepositsToRefundV3, deposit);
        }
        // If fill status is RequestedSlowFill, then we might need to mark down an unexecutable
        // slow fill that we're going to replace with an expired deposit refund.
        // If deposit cannot be slow filled, then exit early.
        if (fillStatus !== FillStatus.RequestedSlowFill) {
          return;
        }
        // Now, check if there was a slow fill created for this deposit in a previous bundle which would now be
        // unexecutable. Mark this deposit as having created an unexecutable slow fill if there is no matching
        // slow fill request or the matching slow fill request took place in a previous bundle.

        // If there is a slow fill request in this bundle, then the expired deposit refund will supercede
        // the slow fill request. If there is no slow fill request seen or its older than this bundle, then we can
        // assume a slow fill leaf was created for it because its tokens are equivalent. The slow fill request was
        // also sent before the fill deadline expired since we checked that above.
        if (
          // Since this deposit was requested for a slow fill in an older bundle at this point, we don't
          // technically need to check if the slow fill request was valid since we can assume all bundles in the past
          // were validated. However, we might as well double check.
          this.clients.hubPoolClient.areTokensEquivalent(
            deposit.inputToken,
            deposit.originChainId,
            deposit.outputToken,
            deposit.destinationChainId,
            deposit.quoteBlockNumber
          ) &&
          (!slowFillRequest || slowFillRequest.blockNumber < destinationBlockRange[0])
        ) {
          validatedBundleUnexecutableSlowFills.push(deposit);
        }
      }
    });

    // Batch compute V3 lp fees.
    start = performance.now();
    const promises = [
      validatedBundleV3Fills.length > 0
        ? this.clients.hubPoolClient.batchComputeRealizedLpFeePct(
            validatedBundleV3Fills.map((fill) => {
              const matchedDeposit = v3RelayHashes[this.getRelayHashFromEvent(fill)].deposit;
              assert(isDefined(matchedDeposit));
              const { chainToSendRefundTo: paymentChainId } = getRefundInformationFromFill(
                fill,
                this.clients.hubPoolClient,
                blockRangesForChains,
                chainIds,
                matchedDeposit.fromLiteChain
              );
              return {
                ...fill,
                paymentChainId,
              };
            })
          )
        : [],
      validatedBundleSlowFills.length > 0
        ? this.clients.hubPoolClient.batchComputeRealizedLpFeePct(
            validatedBundleSlowFills.map((deposit) => {
              return {
                ...deposit,
                paymentChainId: deposit.destinationChainId,
              };
            })
          )
        : [],
      validatedBundleUnexecutableSlowFills.length > 0
        ? this.clients.hubPoolClient.batchComputeRealizedLpFeePct(
            validatedBundleUnexecutableSlowFills.map((deposit) => {
              return {
                ...deposit,
                paymentChainId: deposit.destinationChainId,
              };
            })
          )
        : [],
    ];
    const [v3FillLpFees, v3SlowFillLpFees, v3UnexecutableSlowFillLpFees] = await Promise.all(promises);
    this.logger.debug({
      at: "BundleDataClient#loadData",
      message: `Computed batch async LP fees in ${performance.now() - start}ms.`,
    });
    v3FillLpFees.forEach(({ realizedLpFeePct }, idx) => {
      const fill = validatedBundleV3Fills[idx];
      const associatedDeposit = v3RelayHashes[this.getRelayHashFromEvent(fill)].deposit;
      assert(isDefined(associatedDeposit));
      const { chainToSendRefundTo, repaymentToken } = getRefundInformationFromFill(
        fill,
        this.clients.hubPoolClient,
        blockRangesForChains,
        chainIds,
        associatedDeposit.fromLiteChain
      );
      updateBundleFillsV3(bundleFillsV3, fill, realizedLpFeePct, chainToSendRefundTo, repaymentToken);
    });
    v3SlowFillLpFees.forEach(({ realizedLpFeePct: lpFeePct }, idx) => {
      const deposit = validatedBundleSlowFills[idx];
      updateBundleSlowFills(bundleSlowFillsV3, { ...deposit, lpFeePct });
    });
    v3UnexecutableSlowFillLpFees.forEach(({ realizedLpFeePct: lpFeePct }, idx) => {
      const deposit = validatedBundleUnexecutableSlowFills[idx];
      updateBundleExcessSlowFills(unexecutableSlowFills, { ...deposit, lpFeePct });
    });

    const v3SpokeEventsReadable = prettyPrintV3SpokePoolEvents(
      bundleDepositsV3,
      bundleFillsV3,
      bundleInvalidFillsV3,
      bundleSlowFillsV3,
      expiredDepositsToRefundV3,
      unexecutableSlowFills
    );

    if (bundleInvalidFillsV3.length > 0) {
      this.logger.debug({
        at: "BundleDataClient#loadData",
        message: "Finished loading V3 spoke pool data and found some invalid V3 fills in range",
        blockRangesForChains,
        bundleInvalidFillsV3,
      });
    }

    this.logger.debug({
      at: "BundleDataClient#loadDataFromScratch",
      message: `Computed bundle data in ${Math.round(performance.now() - start) / 1000}s.`,
      blockRangesForChains: JSON.stringify(blockRangesForChains),
      v3SpokeEventsReadable,
    });
    return {
      bundleDepositsV3,
      expiredDepositsToRefundV3,
      bundleFillsV3,
      unexecutableSlowFills,
      bundleSlowFillsV3,
    };
  }

  // Internal function to uniquely identify a bridge event. This is preferred over `SDK.getRelayDataHash` which returns
  // keccak256 hash of the relay data, which can be used as input into the on-chain `fillStatuses()` function in the
  // spoke pool contract. However, this internal function is used to uniquely identify a bridging event
  // for speed since its easier to build a string from the event data than to hash it.
  private getRelayHashFromEvent(event: V3DepositWithBlock | V3FillWithBlock | SlowFillRequestWithBlock): string {
    return `${event.depositor}-${event.recipient}-${event.exclusiveRelayer}-${event.inputToken}-${event.outputToken}-${event.inputAmount}-${event.outputAmount}-${event.originChainId}-${event.depositId}-${event.fillDeadline}-${event.exclusivityDeadline}-${event.message}-${event.destinationChainId}`;
  }

  async getBundleBlockTimestamps(
    chainIds: number[],
    blockRangesForChains: number[][],
    spokePoolClients: SpokePoolClientsByChain
  ): Promise<{ [chainId: string]: number[] }> {
    return Object.fromEntries(
      (
        await utils.mapAsync(chainIds, async (chainId, index) => {
          const blockRangeForChain = blockRangesForChains[index];
          if (!isDefined(blockRangeForChain) || isChainDisabled(blockRangeForChain)) {
            return;
          }
          const [_startBlockForChain, _endBlockForChain] = blockRangeForChain;
          const spokePoolClient = spokePoolClients[chainId];

          // Relayer instances using the BundleDataClient for repayment estimates may only relay on a subset of chains.
          if (!isDefined(spokePoolClient)) {
            return;
          }

          // We can assume that in production the block ranges passed into this function would never
          // contain blocks where the spoke pool client hasn't queried. This is because this function
          // will usually be called in production with block ranges that were validated by
          // DataworkerUtils.blockRangesAreInvalidForSpokeClients.
          const startBlockForChain = Math.min(_startBlockForChain, spokePoolClient.latestBlockSearched);
          const endBlockForChain = Math.min(_endBlockForChain, spokePoolClient.latestBlockSearched);
          const [startTime, endTime] = [
            Number((await spokePoolClient.spokePool.provider.getBlock(startBlockForChain)).timestamp),
            Number((await spokePoolClient.spokePool.provider.getBlock(endBlockForChain)).timestamp),
          ];
          // Sanity checks:
          assert(endTime >= startTime, "End time should be greater than start time.");
          assert(startTime > 0, "Start time should be greater than 0.");
          return [chainId, [startTime, endTime]];
        })
      ).filter(isDefined)
    );
  }
}

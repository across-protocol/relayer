import * as _ from "lodash";
import {
  DepositWithBlock,
  FillsToRefund,
  FillWithBlock,
  ProposedRootBundle,
  RefundRequestWithBlock,
  UnfilledDeposit,
  UnfilledDepositsForOriginChain,
} from "../interfaces";
import { SpokePoolClient } from "../clients";
import {
  winston,
  BigNumber,
  toBN,
  assignValidFillToFillsToRefund,
  getRefundInformationFromFill,
  updateTotalRefundAmount,
  updateTotalRealizedLpFeePct,
  flattenAndFilterUnfilledDepositsByOriginChain,
  updateUnfilledDepositsWithMatchedDeposit,
  getUniqueDepositsInRange,
  getUniqueEarlyDepositsInRange,
  queryHistoricalDepositForFill,
} from "../utils";
import { Clients } from "../common";
import {
  getBlockRangeForChain,
  getImpliedBundleBlockRanges,
  getEndBlockBuffers,
  prettyPrintSpokePoolEvents,
} from "../dataworker/DataworkerUtils";
import { getWidestPossibleExpectedBlockRange, isChainDisabled } from "../dataworker/PoolRebalanceUtils";
import { clients } from "@across-protocol/sdk-v2";
// eslint-disable-next-line node/no-missing-import
import { FundsDepositedEvent } from "@across-protocol/sdk-v2/dist/typechain";
const { refundRequestIsValid, isUBAActivatedAtBlock } = clients;

type DataCacheValue = {
  unfilledDeposits: UnfilledDeposit[];
  fillsToRefund: FillsToRefund;
  allValidFills: FillWithBlock[];
  deposits: DepositWithBlock[];
  earlyDeposits: FundsDepositedEvent[];
};
type DataCache = Record<string, DataCacheValue>;

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

  loadDataFromCache(key: string): DataCacheValue {
    // Always return a deep cloned copy of object stored in cache. Since JS passes by reference instead of value, we
    // want to minimize the risk that the programmer accidentally mutates data in the cache.
    return _.cloneDeep(this.loadDataCache[key]);
  }

  async getPendingRefundsFromValidBundles(bundleLookback: number): Promise<FillsToRefund[]> {
    const refunds = [];
    if (!this.clients.hubPoolClient.isUpdated || this.clients.hubPoolClient.latestBlockNumber === undefined) {
      throw new Error("BundleDataClient::getPendingRefundsFromValidBundles HubPoolClient not updated.");
    }

    let latestBlock = this.clients.hubPoolClient.latestBlockNumber;
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
      this.clients.hubPoolClient.latestBlockNumber,
      this.clients.configStoreClient.getEnabledChains(this.clients.hubPoolClient.latestBlockNumber)
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
          refunds[relayer] = executedAmount.gt(refunds[relayer]) ? toBN(0) : refunds[relayer].sub(executedAmount);
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
    }, toBN(0));
  }

  // Common data re-formatting logic shared across all data worker public functions.
  // User must pass in spoke pool to search event data against. This allows the user to refund relays and fill deposits
  // on deprecated spoke pools.
  async loadData(
    blockRangesForChains: number[][],
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    logData = true
  ): Promise<{
    unfilledDeposits: UnfilledDeposit[];
    fillsToRefund: FillsToRefund;
    allValidFills: FillWithBlock[];
    deposits: DepositWithBlock[];
    earlyDeposits: FundsDepositedEvent[];
  }> {
    const mainnetStartBlock = getBlockRangeForChain(
      blockRangesForChains,
      this.clients.hubPoolClient.chainId,
      this.chainIdListForBundleEvaluationBlockNumbers
    )[0];
    let isUBA = false;
    if (isUBAActivatedAtBlock(this.clients.hubPoolClient, mainnetStartBlock, this.clients.hubPoolClient.chainId)) {
      isUBA = true;
    }
    return this._loadData(blockRangesForChains, spokePoolClients, isUBA, logData);
  }
  async _loadData(
    blockRangesForChains: number[][],
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    isUBA = false,
    logData = true
  ): Promise<{
    unfilledDeposits: UnfilledDeposit[];
    fillsToRefund: FillsToRefund;
    allValidFills: FillWithBlock[];
    deposits: DepositWithBlock[];
    earlyDeposits: FundsDepositedEvent[];
  }> {
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
    const earlyDeposits: FundsDepositedEvent[] = [];

    // Save refund in-memory for validated fill.
    const addRefundForValidFill = (
      fillWithBlock: FillWithBlock,
      matchedDeposit: DepositWithBlock,
      blockRangeForChain: number[]
    ) => {
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

      // Note: the UBA model doesn't use the following realized LP fees data but we keep it for backwards
      // compatibility.
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
        if (historicalDeposit) {
          addRefundForValidFill(fill, historicalDeposit, blockRangeForChain);
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
    const allChainIds = blockRangesForChains.map(
      (_blockRange, index) => this.chainIdListForBundleEvaluationBlockNumbers[index]
    );

    const validateRefundRequestAndSaveData = async (refundRequest: RefundRequestWithBlock): Promise<void> => {
      const result = await refundRequestIsValid(spokePoolClients, this.clients.hubPoolClient, refundRequest);
      if (result.valid) {
        const { blockNumber, transactionIndex, transactionHash, logIndex, ...fill } = result.matchingFill;
        assignValidFillToFillsToRefund(fillsToRefund, fill, refundRequest.repaymentChainId, refundRequest.refundToken);
        updateTotalRefundAmount(fillsToRefund, fill, refundRequest.repaymentChainId, refundRequest.refundToken);
      } else {
        this.logger.warn({
          at: "SpokePoolClient#validateRefundRequestAndSaveData",
          message: "Invalid refund request",
          refundRequest,
          invalidReason: result.reason,
        });
      }
    };

    for (const originChainId of allChainIds) {
      if (_isChainDisabled(originChainId)) {
        continue;
      }

      const originClient = spokePoolClients[originChainId];
      if (!originClient.isUpdated) {
        throw new Error(`origin SpokePoolClient on chain ${originChainId} not updated`);
      }

      // Loop over all other SpokePoolClient's to find deposits whose destination chain is the selected origin chain.
      for (const destinationChainId of allChainIds) {
        if (originChainId === destinationChainId) {
          continue;
        }
        if (_isChainDisabled(destinationChainId)) {
          continue;
        }

        const destinationClient = spokePoolClients[destinationChainId];
        if (!destinationClient.isUpdated) {
          throw new Error(`destination SpokePoolClient with chain ID ${destinationChainId} not updated`);
        }

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
          .filter((fillWithBlock) => fillWithBlock.blockNumber <= blockRangeForChain[1]);
        // In the UBA model, fills that request repayment on another chain must send a separate refund request
        // in order to mark their place in the outflow queue for that chain. This is because the UBA determines
        // fees based on sequencing of events. Pre-UBA, the fee model treats each fill independently so there
        // is no need to mark a fill's place in line on the repayment chain.
        await Promise.all(
          fillsForOriginChain
            .filter((fill) => !isUBA || fill.destinationChainId === fill.repaymentChainId)
            .map((fill) => validateFillAndSaveData(fill, blockRangeForChain))
        );
      }

      // Handle fills that requested repayment on a different chain and submitted a refund request.
      // These should map with only full fills where fill.destinationChainId !== fill.repaymentChainId.
      if (isUBA) {
        const blockRangeForChain = getBlockRangeForChain(
          blockRangesForChains,
          Number(originChainId),
          this.chainIdListForBundleEvaluationBlockNumbers
        );
        const refundRequests = originClient.getRefundRequests(blockRangeForChain[0], blockRangeForChain[1]);
        await Promise.all(refundRequests.map(async (refundRequest) => validateRefundRequestAndSaveData(refundRequest)));
      }
    }

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

    this.loadDataCache[key] = { fillsToRefund, deposits, unfilledDeposits, allValidFills, earlyDeposits };

    return this.loadDataFromCache(key);
  }
}

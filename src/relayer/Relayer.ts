import assert from "assert";
import { utils as sdkUtils } from "@across-protocol/sdk";
import { utils as ethersUtils } from "ethers";
import { FillStatus, L1Token, V3Deposit, V3DepositWithBlock } from "../interfaces";
import {
  BigNumber,
  bnZero,
  bnUint256Max,
  RelayerUnfilledDeposit,
  blockExplorerLink,
  createFormatFunction,
  formatFeePct,
  getCurrentTime,
  getNetworkName,
  getUnfilledDeposits,
  isDefined,
  winston,
  fixedPointAdjustment,
  TransactionResponse,
} from "../utils";
import { RelayerClients } from "./RelayerClientHelper";
import { RelayerConfig } from "./RelayerConfig";

const { getAddress } = ethersUtils;
const { isDepositSpedUp, isMessageEmpty, resolveDepositMessage } = sdkUtils;
const UNPROFITABLE_DEPOSIT_NOTICE_PERIOD = 60 * 60; // 1 hour
const HUB_SPOKE_BLOCK_LAG = 2; // Permit SpokePool timestamps to be ahead of the HubPool by 2 HubPool blocks.

type RepaymentFee = { paymentChainId: number; lpFeePct: BigNumber };
type BatchLPFees = { [depositKey: string]: RepaymentFee[] };
type RepaymentChainProfitability = {
  gasLimit: BigNumber;
  gasCost: BigNumber;
  relayerFeePct: BigNumber;
  lpFeePct: BigNumber;
};

export class Relayer {
  public readonly relayerAddress: string;
  public readonly fillStatus: { [depositHash: string]: number } = {};
  private pendingTxnReceipts: { [chainId: number]: Promise<TransactionResponse[]> } = {};

  private hubPoolBlockBuffer: number;

  constructor(
    relayerAddress: string,
    readonly logger: winston.Logger,
    readonly clients: RelayerClients,
    readonly config: RelayerConfig
  ) {
    Object.values(clients.spokePoolClients).forEach(({ chainId }) => {
      if (!isDefined(config.minDepositConfirmations[chainId])) {
        const chain = getNetworkName(chainId);
        logger.warn({
          at: "Relayer::constructor",
          message: `${chain} deposit confirmation configuration is missing.`,
        });
        config.minDepositConfirmations[chainId] = [
          { usdThreshold: bnUint256Max, minConfirmations: Number.MAX_SAFE_INTEGER },
        ];
      }
    });

    this.relayerAddress = getAddress(relayerAddress);
  }

  /**
   * @description For a given deposit, apply relayer-specific filtering to determine whether it should be filled.
   * @param deposit Deposit object.
   * @param version Version identified for this deposit.
   * @param invalidFills An array of any invalid fills detected for this deposit.
   * @returns A boolean indicator determining whether the relayer configuration permits the deposit to be filled.
   */
  filterDeposit({ deposit, version: depositVersion, invalidFills }: RelayerUnfilledDeposit): boolean {
    const { depositId, originChainId, destinationChainId, depositor, recipient, inputToken, blockNumber } = deposit;
    const { acrossApiClient, configStoreClient, hubPoolClient, profitClient, spokePoolClients } = this.clients;
    const { ignoredAddresses, ignoreLimits, relayerTokens, acceptInvalidFills, minDepositConfirmations } = this.config;
    const [srcChain, dstChain] = [getNetworkName(originChainId), getNetworkName(destinationChainId)];

    // If we don't have the latest code to support this deposit, skip it.
    if (depositVersion > configStoreClient.configStoreVersion) {
      this.logger.warn({
        at: "Relayer::filterDeposit",
        message: "Skipping deposit that is not supported by this relayer version.",
        latestVersionSupported: configStoreClient.configStoreVersion,
        latestInConfigStore: configStoreClient.getConfigStoreVersionForTimestamp(),
        deposit,
      });
      return false;
    }

    if (!this.routeEnabled(originChainId, destinationChainId)) {
      this.logger.debug({
        at: "Relayer::filterDeposit",
        message: "Skipping deposit from or to disabled chains.",
        deposit,
        enabledOriginChains: this.config.relayerOriginChains,
        enabledDestinationChains: this.config.relayerDestinationChains,
      });
      return false;
    }

    // Ensure that the individual deposit meets the minimum deposit confirmation requirements for its value.
    const fillAmountUsd = profitClient.getFillAmountInUsd(deposit);
    const { minConfirmations } = minDepositConfirmations[originChainId].find(({ usdThreshold }) =>
      usdThreshold.gte(fillAmountUsd)
    );
    const { latestBlockSearched } = spokePoolClients[originChainId];
    if (latestBlockSearched - blockNumber < minConfirmations) {
      this.logger.debug({
        at: "Relayer::evaluateFill",
        message: `Skipping ${srcChain} deposit due to insufficient deposit confirmations.`,
        depositId,
        blockNumber,
        confirmations: latestBlockSearched - blockNumber,
        minConfirmations,
        transactionHash: deposit.transactionHash,
      });
      return false;
    }

    // Skip deposits with quoteTimestamp in the future (impossible to know HubPool utilization => LP fee cannot be computed).
    if (deposit.quoteTimestamp - hubPoolClient.currentTime > this.hubPoolBlockBuffer) {
      this.logger.debug({
        at: "Relayer::evaluateFill",
        message: `Skipping ${srcChain} deposit due to future quoteTimestamp.`,
        currentTime: hubPoolClient.currentTime,
        quoteTimestamp: deposit.quoteTimestamp,
        buffer: this.hubPoolBlockBuffer,
        transactionHash: deposit.transactionHash,
      });
      return false;
    }

    if (ignoredAddresses?.includes(getAddress(depositor)) || ignoredAddresses?.includes(getAddress(recipient))) {
      this.logger.debug({
        at: "Relayer::filterDeposit",
        message: `Ignoring ${srcChain} deposit destined for ${dstChain}.`,
        depositor,
        recipient,
        transactionHash: deposit.transactionHash,
      });
      return false;
    }

    // Skip any L1 tokens that are not specified in the config.
    // If relayerTokens is an empty list, we'll assume that all tokens are supported.
    const l1Token = hubPoolClient.getL1TokenInfoForL2Token(inputToken, originChainId);
    if (relayerTokens.length > 0 && !relayerTokens.includes(l1Token.address)) {
      this.logger.debug({
        at: "Relayer::filterDeposit",
        message: "Skipping deposit for unwhitelisted token",
        deposit,
        l1Token,
      });
      return false;
    }

    // It would be preferable to use host time since it's more reliably up-to-date, but this creates issues in test.
    const currentTime = spokePoolClients[destinationChainId].getCurrentTime();
    if (deposit.fillDeadline <= currentTime) {
      return false;
    }

    if (deposit.exclusivityDeadline > currentTime && getAddress(deposit.exclusiveRelayer) !== this.relayerAddress) {
      return false;
    }

    if (!this.clients.inventoryClient.validateOutputToken(deposit)) {
      this.logger[this.config.sendingRelaysEnabled ? "warn" : "debug"]({
        at: "Relayer::filterDeposit",
        message: "Skipping deposit including in-protocol token swap.",
        deposit,
      });
      return false;
    }

    // Skip deposit with message if sending fills with messages is not supported.
    if (!this.config.sendingMessageRelaysEnabled && !isMessageEmpty(resolveDepositMessage(deposit))) {
      this.logger[this.config.sendingRelaysEnabled ? "warn" : "debug"]({
        at: "Relayer::filterDeposit",
        message: "Skipping fill for deposit with message",
        depositUpdated: isDepositSpedUp(deposit),
        deposit,
      });
      return false;
    }

    // Skip deposits that contain invalid fills from the same relayer. This prevents potential corrupted data from
    // making the same relayer fill a deposit multiple times.
    if (!acceptInvalidFills && invalidFills.some((fill) => fill.relayer === this.relayerAddress)) {
      this.logger.error({
        at: "Relayer::filterDeposit",
        message: "👨‍👧‍👦 Skipping deposit with invalid fills from the same relayer",
        deposit,
        invalidFills,
        destinationChainId,
      });
      return false;
    }

    // We query the relayer API to get the deposit limits for different token and origin combinations.
    // The relayer should *not* be filling deposits that the HubPool doesn't have liquidity for otherwise the relayer's
    // refund will be stuck for potentially 7 days. Note: Filter for supported tokens first, since the relayer only
    // queries for limits on supported tokens.
    if (!ignoreLimits) {
      const { inputAmount } = deposit;
      const limit = acrossApiClient.getLimit(originChainId, l1Token.address);
      if (acrossApiClient.updatedLimits && inputAmount.gt(limit)) {
        this.logger.warn({
          at: "Relayer::filterDeposit",
          message: "😱 Skipping deposit with greater unfilled amount than API suggested limit",
          limit,
          l1Token: l1Token.address,
          depositId,
          inputToken,
          inputAmount,
          originChainId,
          transactionHash: deposit.transactionHash,
        });
        return false;
      }
    }

    // The deposit passed all checks, so we can include it in the list of unfilled deposits.
    return true;
  }

  /**
   * @description Retrieve the complete array of unfilled deposits and filter out deposits we can't or choose
   * not to support.
   * @returns An array of filtered RelayerUnfilledDeposit objects.
   */
  private _getUnfilledDeposits(): Record<number, RelayerUnfilledDeposit[]> {
    const { hubPoolClient, spokePoolClients } = this.clients;
    const { relayerDestinationChains } = this.config;

    // Filter the resulting deposits according to relayer configuration.
    return Object.fromEntries(
      Object.values(spokePoolClients)
        .filter(({ chainId }) => relayerDestinationChains?.includes(chainId) ?? true)
        .map(({ chainId: destinationChainId }) => [
          destinationChainId,
          getUnfilledDeposits(destinationChainId, spokePoolClients, hubPoolClient, this.fillStatus).filter((deposit) =>
            this.filterDeposit(deposit)
          ),
        ])
    );
  }

  /**
   * @description Validate whether the origin and destination chain combination is permitted by relayer config.
   * @param originChainId chain ID for the deposit.
   * @param destinationChainId Chain ID of a prospective fill.
   * @returns True if the route is permitted by config (or enabled by default), otherwise false.
   */
  routeEnabled(originChainId: number, destinationChainId: number): boolean {
    const { relayerOriginChains: originChains, relayerDestinationChains: destinationChains } = this.config;

    if (originChains?.length > 0 && !originChains.includes(originChainId)) {
      return false;
    }

    if (destinationChains?.length > 0 && !destinationChains.includes(destinationChainId)) {
      return false;
    }

    return true;
  }

  computeRequiredDepositConfirmations(
    deposits: V3Deposit[],
    destinationChainId: number
  ): { [chainId: number]: number } {
    const { profitClient, tokenClient } = this.clients;
    const { minDepositConfirmations } = this.config;

    // Sum the total unfilled deposit amount per origin chain and set a MDC for that chain.
    // Filter out deposits where the relayer doesn't have the balance to make the fill.
    const unfilledDepositAmountsPerChain: { [chainId: number]: BigNumber } = deposits
      .filter((deposit) => tokenClient.hasBalanceForFill(deposit))
      .reduce((agg, deposit) => {
        const unfilledAmountUsd = profitClient.getFillAmountInUsd(deposit);
        agg[deposit.originChainId] = (agg[deposit.originChainId] ?? bnZero).add(unfilledAmountUsd);
        return agg;
      }, {});

    // Set the MDC for each origin chain equal to lowest threshold greater than the unfilled USD deposit amount.
    const mdcPerChain = Object.fromEntries(
      Object.entries(unfilledDepositAmountsPerChain).map(([chainId, unfilledAmount]) => {
        const { minConfirmations } = minDepositConfirmations[chainId].find(({ usdThreshold }) =>
          usdThreshold.gte(unfilledAmount)
        );

        // If no thresholds are greater than unfilled amount, then use fallback which should have largest MDCs.
        return [chainId, minConfirmations];
      })
    );

    const dstChain = getNetworkName(destinationChainId);
    this.logger.debug({
      at: "Relayer::computeRequiredDepositConfirmations",
      message: `Setting minimum ${dstChain} deposit confirmation based on origin chain aggregate deposit amount.`,
      unfilledDepositAmountsPerChain,
      mdcPerChain,
    });

    return mdcPerChain;
  }

  // Iterate over all unfilled deposits. For each unfilled deposit, check that:
  // a) it exceeds the minimum number of required block confirmations,
  // b) the token balance client has enough tokens to fill it,
  // c) the fill is profitable.
  // If all hold true then complete the fill. If there is insufficient balance to complete the fill and slow fills are
  // enabled then request a slow fill instead.
  async evaluateFill(
    deposit: V3DepositWithBlock,
    fillStatus: number,
    lpFees: RepaymentFee[],
    maxBlockNumber: number,
    sendSlowRelays: boolean
  ): Promise<void> {
    const { depositId, depositor, recipient, destinationChainId, originChainId, inputToken } = deposit;
    const { hubPoolClient, profitClient, tokenClient } = this.clients;
    const { slowDepositors } = this.config;

    // If the deposit does not meet the minimum number of block confirmations, skip it.
    if (deposit.blockNumber > maxBlockNumber) {
      const chain = getNetworkName(originChainId);
      this.logger.debug({
        at: "Relayer::evaluateFill",
        message: `Skipping ${chain} deposit ${depositId} due to insufficient deposit confirmations.`,
        depositId,
        blockNumber: deposit.blockNumber,
        maxBlockNumber,
        transactionHash: deposit.transactionHash,
      });
      // If we're in simulation mode, skip this early exit so that the user can evaluate
      // the full simulation run.
      if (this.config.sendingRelaysEnabled) {
        return;
      }
    }

    // If depositor is on the slow deposit list, then send a zero fill to initiate a slow relay and return early.
    if (slowDepositors?.includes(depositor) && fillStatus === FillStatus.Unfilled) {
      this.logger.debug({
        at: "Relayer::evaluateFill",
        message: "Initiating slow fill for grey listed depositor",
        depositor,
      });
      this.requestSlowFill(deposit);
      return;
    }

    const l1Token = hubPoolClient.getL1TokenInfoForL2Token(inputToken, originChainId);
    const selfRelay = [depositor, recipient].every((address) => address === this.relayerAddress);
    if (tokenClient.hasBalanceForFill(deposit) && !selfRelay) {
      const { repaymentChainId, repaymentChainProfitability } = await this.resolveRepaymentChain(
        deposit,
        l1Token,
        lpFees
      );
      const { relayerFeePct, gasCost, gasLimit: _gasLimit, lpFeePct: realizedLpFeePct } = repaymentChainProfitability;
      if (isDefined(repaymentChainId)) {
        const gasLimit = isMessageEmpty(resolveDepositMessage(deposit)) ? undefined : _gasLimit;
        this.fillRelay(deposit, repaymentChainId, realizedLpFeePct, gasLimit);

        // Update local balance to account for the enqueued fill.
        tokenClient.decrementLocalBalance(destinationChainId, deposit.outputToken, deposit.outputAmount);
      } else {
        profitClient.captureUnprofitableFill(deposit, realizedLpFeePct, relayerFeePct, gasCost);
      }
    } else if (selfRelay) {
      // Prefer exiting early here to avoid fast filling any deposits we send. This approach assumes that we always
      // prefer someone else to fill the deposits.
      if (deposit.fromLiteChain) {
        this.logger.debug({
          at: "Relayer::evaluateFill",
          message: "Skipping self-relay deposit originating from lite chain.",
          originChainId,
          depositId,
        });
        return;
      }
      // A relayer can fill its own deposit without an ERC20 transfer. Only bypass profitability requirements if the
      // relayer is both the depositor and the recipient, because a deposit on a cheap SpokePool chain could cause
      // expensive fills on (for example) mainnet.
      const { lpFeePct } = lpFees.find((lpFee) => lpFee.paymentChainId === destinationChainId);
      this.fillRelay(deposit, destinationChainId, lpFeePct);
    } else {
      // TokenClient.getBalance returns that we don't have enough balance to submit the fast fill.
      // At this point, capture the shortfall so that the inventory manager can rebalance the token inventory.
      tokenClient.captureTokenShortfallForFill(deposit);
      if (sendSlowRelays && fillStatus === FillStatus.Unfilled) {
        this.requestSlowFill(deposit);
      }
    }
  }

  /**
   * For a given deposit, map its relevant attributes to a string to be used as a lookup into the LP fee structure.
   * @param relayData An object consisting of an originChainId, inputToken, inputAmount and quoteTimestamp.
   * @returns A string identifying the deposit in a BatchLPFees object.
   */
  getLPFeeKey(relayData: Pick<V3Deposit, "originChainId" | "inputToken" | "inputAmount" | "quoteTimestamp">): string {
    return `${relayData.originChainId}-${relayData.inputToken}-${relayData.inputAmount}-${relayData.quoteTimestamp}`;
  }

  /**
   * For a given destination chain, evaluate and optionally fill each unfilled deposit. Note that each fill should be
   * evaluated sequentially in order to ensure atomic balance updates.
   * @param deposits An array of deposits destined for the same destination chain.
   * @param maxBlockNumbers A map of the highest block number per origin chain to fill.
   * @returns void
   */
  async evaluateFills(
    deposits: (V3DepositWithBlock & { fillStatus: number })[],
    lpFees: BatchLPFees,
    maxBlockNumbers: { [chainId: number]: number },
    sendSlowRelays: boolean
  ): Promise<void> {
    for (let i = 0; i < deposits.length; ++i) {
      const { fillStatus, ...deposit } = deposits[i];
      const relayerLpFees = lpFees[this.getLPFeeKey(deposit)];
      await this.evaluateFill(
        deposit,
        fillStatus,
        relayerLpFees,
        maxBlockNumbers[deposit.originChainId],
        sendSlowRelays
      );
    }
  }

  /**
   * For an array of unfilled deposits, compute the applicable LP fee for each. Fees are computed for all possible
   * repayment chains which include origin, destination, all slow-withdrawal chains and mainnet.
   * @param deposits An array of deposits.
   * @returns A BatchLPFees object uniquely identifying LP fees per unique input deposit.
   */
  async batchComputeLpFees(deposits: V3DepositWithBlock[]): Promise<BatchLPFees> {
    const { hubPoolClient, inventoryClient } = this.clients;

    // We need to compute LP fees for any possible repayment chain the inventory client could select
    // for each deposit filled.
    const lpFeeRequests = deposits
      .map((deposit) => {
        const possibleRepaymentChainIds = inventoryClient.getPossibleRepaymentChainIds(deposit);
        return possibleRepaymentChainIds.map((paymentChainId) => {
          return { ...deposit, paymentChainId };
        });
      })
      .flat();

    const _lpFees = await hubPoolClient.batchComputeRealizedLpFeePct(lpFeeRequests);

    const lpFees: BatchLPFees = _lpFees.reduce((acc, { realizedLpFeePct: lpFeePct }, idx) => {
      const lpFeeRequest = lpFeeRequests[idx];
      const { paymentChainId } = lpFeeRequest;
      const key = this.getLPFeeKey(lpFeeRequest);
      acc[key] ??= [];
      acc[key].push({ paymentChainId, lpFeePct });
      return acc;
    }, {});

    return lpFees;
  }

  protected async executeFills(chainId: number, simulate = false): Promise<string[]> {
    const {
      pendingTxnReceipts,
      clients: { multiCallerClient },
    } = this;

    if (isDefined(pendingTxnReceipts[chainId])) {
      this.logger.info({
        at: "Relayer::executeFills",
        message: `${getNetworkName(chainId)} transaction queue has pending fills; skipping...`,
      });
      multiCallerClient.clearTransactionQueue(chainId);
      return [];
    }
    pendingTxnReceipts[chainId] = multiCallerClient.executeTxnQueue(chainId, simulate);
    const txnReceipts = await pendingTxnReceipts[chainId];
    delete pendingTxnReceipts[chainId];

    return txnReceipts.map(({ hash }) => hash);
  }

  async checkForUnfilledDepositsAndFill(
    sendSlowRelays = true,
    simulate = false
  ): Promise<{ [chainId: number]: Promise<string[]> }> {
    const { hubPoolClient, profitClient, spokePoolClients, tokenClient, multiCallerClient } = this.clients;

    // Fetch the average block time for mainnet, for later use in evaluating quoteTimestamps.
    this.hubPoolBlockBuffer ??= Math.ceil(
      HUB_SPOKE_BLOCK_LAG * (await sdkUtils.averageBlockTime(hubPoolClient.hubPool.provider)).average
    );

    // Flush any pre-existing enqueued transactions that might not have been executed.
    multiCallerClient.clearTransactionQueue();
    const txnReceipts: { [chainId: number]: Promise<string[]> } = Object.fromEntries(
      Object.values(spokePoolClients).map(({ chainId }) => [chainId, []])
    );

    // Fetch unfilled deposits and filter out deposits upfront before we compute the minimum deposit confirmation
    // per chain, which is based on the deposit volume we could fill.
    const unfilledDeposits = this._getUnfilledDeposits();
    const allUnfilledDeposits = Object.values(unfilledDeposits)
      .flat()
      .map(({ deposit }) => deposit);

    this.logger.debug({
      at: "Relayer::checkForUnfilledDepositsAndFill",
      message: `${allUnfilledDeposits.length} unfilled deposits found.`,
    });
    if (allUnfilledDeposits.length === 0) {
      return txnReceipts;
    }

    const lpFees = await this.batchComputeLpFees(allUnfilledDeposits);
    await sdkUtils.forEachAsync(Object.entries(unfilledDeposits), async ([chainId, _deposits]) => {
      if (_deposits.length === 0) {
        return;
      }

      const destinationChainId = Number(chainId);
      const deposits = _deposits.map(({ deposit }) => deposit);
      const fillStatus = await sdkUtils.fillStatusArray(spokePoolClients[destinationChainId].spokePool, deposits);

      const unfilledDeposits = deposits
        .map((deposit, idx) => ({ ...deposit, fillStatus: fillStatus[idx] }))
        .filter(({ fillStatus, ...deposit }) => {
          // Track the fill status for faster filtering on subsequent loops.
          const depositHash = spokePoolClients[deposit.destinationChainId].getDepositHash(deposit);
          this.fillStatus[depositHash] = fillStatus;
          return fillStatus !== FillStatus.Filled;
        });

      const mdcPerChain = this.computeRequiredDepositConfirmations(unfilledDeposits, destinationChainId);
      const maxBlockNumbers = Object.fromEntries(
        Object.values(spokePoolClients).map(({ chainId, latestBlockSearched }) => [
          chainId,
          latestBlockSearched - mdcPerChain[chainId],
        ])
      );
      await this.evaluateFills(unfilledDeposits, lpFees, maxBlockNumbers, sendSlowRelays);

      if (multiCallerClient.getQueuedTransactions(destinationChainId).length > 0) {
        txnReceipts[destinationChainId] = this.executeFills(destinationChainId, simulate);
      }
    });

    // If during the execution run we had shortfalls or unprofitable fills then handel it by producing associated logs.
    if (tokenClient.anyCapturedShortFallFills()) {
      this.handleTokenShortfall();
    }
    if (profitClient.anyCapturedUnprofitableFills()) {
      this.handleUnprofitableFill();
    }

    return txnReceipts;
  }

  requestSlowFill(deposit: V3Deposit): void {
    // don't request slow fill if origin/destination chain is a lite chain
    if (deposit.fromLiteChain || deposit.toLiteChain) {
      this.logger.debug({
        at: "Relayer::requestSlowFill",
        message: "Prevent requesting slow fill request to/from lite chain.",
        deposit,
      });
      return;
    }

    // Verify that the _original_ message was empty, since that's what would be used in a slow fill. If a non-empty
    // message was nullified by an update, it can be full-filled but preferably not automatically zero-filled.
    if (!isMessageEmpty(deposit.message)) {
      this.logger.warn({
        at: "Relayer::requestSlowFill",
        message: "Suppressing slow fill request for deposit with message.",
        deposit,
      });
      return;
    }

    const { hubPoolClient, spokePoolClients, multiCallerClient } = this.clients;
    const { originChainId, destinationChainId, depositId, outputToken } = deposit;
    const spokePoolClient = spokePoolClients[destinationChainId];
    const slowFillRequest = spokePoolClient.getSlowFillRequest(deposit);
    if (isDefined(slowFillRequest)) {
      return; // Slow fill has already been requested; nothing to do.
    }

    const formatSlowFillRequestMarkdown = (): string => {
      const { symbol, decimals } = hubPoolClient.getTokenInfo(destinationChainId, outputToken);
      const formatter = createFormatFunction(2, 4, false, decimals);
      const outputAmount = formatter(deposit.outputAmount);
      const [srcChain, dstChain] = [getNetworkName(originChainId), getNetworkName(destinationChainId)];

      // @todo (future) infer the updated outputAmount by zeroing the relayer fee in order to print the correct amount.
      return (
        `Requested slow fill 🐌 of ${outputAmount} ${symbol}` +
        ` on ${dstChain} for ${srcChain} depositId ${depositId}.`
      );
    };

    this.logger.debug({ at: "Relayer::requestSlowFill", message: "Enqueuing slow fill request.", deposit });
    multiCallerClient.enqueueTransaction({
      chainId: destinationChainId,
      contract: spokePoolClient.spokePool,
      method: "requestV3SlowFill",
      args: [deposit],
      message: "Requested slow fill for deposit.",
      mrkdwn: formatSlowFillRequestMarkdown(),
    });
  }

  fillRelay(deposit: V3Deposit, repaymentChainId: number, realizedLpFeePct: BigNumber, gasLimit?: BigNumber): void {
    const { spokePoolClients, multiCallerClient } = this.clients;
    this.logger.debug({
      at: "Relayer::fillRelay",
      message: `Filling v3 deposit ${deposit.depositId} with repayment on ${repaymentChainId}.`,
      deposit,
      repaymentChainId,
      realizedLpFeePct,
    });

    // If a deposit originates from a lite chain, then the repayment chain must be the origin chain.
    assert(
      !deposit.fromLiteChain || repaymentChainId === deposit.originChainId,
      `Lite chain deposits must be filled on its origin chain (${deposit.originChainId}). Deposit Id: ${deposit.depositId}.`
    );

    const [method, messageModifier, args] = !isDepositSpedUp(deposit)
      ? ["fillV3Relay", "", [deposit, repaymentChainId]]
      : [
          "fillV3RelayWithUpdatedDeposit",
          " with updated parameters ",
          [
            deposit,
            repaymentChainId,
            deposit.updatedOutputAmount,
            deposit.updatedRecipient,
            deposit.updatedMessage,
            deposit.speedUpSignature,
          ],
        ];

    const message = `Filled v3 deposit ${messageModifier}🚀`;
    const mrkdwn = this.constructRelayFilledMrkdwn(deposit, repaymentChainId, realizedLpFeePct);
    const contract = spokePoolClients[deposit.destinationChainId].spokePool;
    const chainId = deposit.destinationChainId;
    multiCallerClient.enqueueTransaction({ contract, chainId, method, args, gasLimit, message, mrkdwn });
  }

  /**
   * @notice Returns repayment chain choice for deposit given repayment fees and the hubPoolToken associated with the
   * deposit inputToken.
   * @param deposit
   * @param hubPoolToken L1 token object associated with the deposit inputToken.
   * @param repaymentFees
   * @returns repaymentChainId is defined if and only if a profitable repayment chain is found.
   * @returns repaymentChainProfitability contains the profitability data of the repaymentChainId if it is defined
   * or the profitability data of the most preferred repayment chain otherwise.
   */
  protected async resolveRepaymentChain(
    deposit: V3DepositWithBlock,
    hubPoolToken: L1Token,
    repaymentFees: RepaymentFee[]
  ): Promise<{
    repaymentChainId?: number;
    repaymentChainProfitability: RepaymentChainProfitability;
  }> {
    const { inventoryClient, profitClient } = this.clients;
    const { depositId, originChainId, destinationChainId, inputAmount, outputAmount, transactionHash, fromLiteChain } =
      deposit;
    const originChain = getNetworkName(originChainId);
    const destinationChain = getNetworkName(destinationChainId);

    const start = performance.now();
    const preferredChainIds = await inventoryClient.determineRefundChainId(deposit, hubPoolToken.address);
    assert(preferredChainIds.length > 0, `No preferred repayment chains found for deposit ${depositId}.`);
    this.logger.debug({
      at: "Relayer::resolveRepaymentChain",
      message: `Determined eligible repayment chains ${JSON.stringify(
        preferredChainIds
      )} for deposit ${depositId} from ${originChain} to ${destinationChain} in ${
        Math.round(performance.now() - start) / 1000
      }s.`,
    });
    const _repaymentFees = preferredChainIds.map((chainId) =>
      repaymentFees.find(({ paymentChainId }) => paymentChainId === chainId)
    );
    const lpFeePcts = _repaymentFees.map(({ lpFeePct }) => lpFeePct);

    // For each eligible repayment chain, compute profitability and pick the one that is profitable. If none are
    // profitable, then finally check the destination chain even if its not a preferred repayment chain. The idea
    // here is that depositors are receiving quoted lp fees from the API that assumes repayment on the destination
    // chain, so we should honor all repayments on the destination chain if it's profitable, even if it doesn't
    // fit within our inventory management.

    const getRepaymentChainProfitability = async (
      preferredChainId: number,
      lpFeePct: BigNumber
    ): Promise<{ profitable: boolean; gasLimit: BigNumber; gasCost: BigNumber; relayerFeePct: BigNumber }> => {
      const {
        profitable,
        nativeGasCost: gasLimit,
        tokenGasCost: gasCost,
        netRelayerFeePct: relayerFeePct, // net relayer fee is equal to total fee minus the lp fee.
      } = await profitClient.isFillProfitable(deposit, lpFeePct, hubPoolToken, preferredChainId);
      return {
        profitable,
        gasLimit,
        gasCost,
        relayerFeePct,
      };
    };

    const repaymentChainProfitabilities = await Promise.all(
      preferredChainIds.map(async (preferredChainId, i) => {
        const lpFeePct = lpFeePcts[i];
        assert(isDefined(lpFeePct), `Missing lp fee pct for chain potential repayment chain ${preferredChainId}`);
        return getRepaymentChainProfitability(preferredChainId, lpFeePcts[i]);
      })
    );
    const profitableRepaymentChainIds = preferredChainIds.filter((_, i) => repaymentChainProfitabilities[i].profitable);

    // @dev preferredChainId will not be defined until a chain is found to be profitable.
    let preferredChain: number | undefined = undefined;

    // @dev The following internal function should be the only one used to set `preferredChain` above.
    const getProfitabilityDataForPreferredChainIndex = (preferredChainIndex: number): RepaymentChainProfitability => {
      const lpFeePct = lpFeePcts[preferredChainIndex];
      const { gasLimit, gasCost, relayerFeePct } = repaymentChainProfitabilities[preferredChainIndex];
      return {
        gasLimit,
        gasCost,
        relayerFeePct,
        lpFeePct,
      };
    };
    let profitabilityData: RepaymentChainProfitability = getProfitabilityDataForPreferredChainIndex(0);

    // If there are any profitable repayment chains, then set preferred chain to the first one since the preferred
    // chains are given to us by the InventoryClient sorted in priority order.

    if (profitableRepaymentChainIds.length > 0) {
      preferredChain = profitableRepaymentChainIds[0];
      const preferredChainIndex = preferredChainIds.indexOf(preferredChain);
      profitabilityData = getProfitabilityDataForPreferredChainIndex(preferredChainIndex);
      this.logger.debug({
        at: "Relayer::resolveRepaymentChain",
        message: `Selected preferred repayment chain ${preferredChain} for deposit ${depositId}, #${
          preferredChainIndex + 1
        } in eligible chains ${JSON.stringify(preferredChainIds)} list.`,
        profitableRepaymentChainIds,
      });
    }

    // If none of the preferred chains are profitable and they also don't include the destination chain,
    // then check if the destination chain is profitable.
    // This assumes that the depositor is getting quotes from the /suggested-fees endpoint
    // in the frontend repo which assumes that repayment is the destination chain. If this is profitable, then
    // go ahead and use the preferred chain as repayment and log the lp fee delta. This is a temporary solution
    // so that depositors can continue to quote lp fees assuming repayment is on the destination chain until
    // we come up with a smarter fee quoting algorithm that takes into account relayer inventory management more
    // accurately.
    //
    // Additionally we don't want to take this code path if the chain is a lite chain because we can't reason about
    // destination chain repayments on lite chains.
    if (!isDefined(preferredChain) && !preferredChainIds.includes(destinationChainId) && !fromLiteChain) {
      this.logger.debug({
        at: "Relayer::resolveRepaymentChain",
        message: `Preferred chains ${JSON.stringify(
          preferredChainIds
        )} are not profitable. Checking destination chain ${destinationChainId} profitability.`,
        deposit: { originChain, depositId, destinationChain, transactionHash },
      });
      // Evaluate destination chain profitability to see if we can reset preferred chain.
      const { lpFeePct: destinationChainLpFeePct } = repaymentFees.find(
        ({ paymentChainId }) => paymentChainId === destinationChainId
      );
      assert(isDefined(destinationChainLpFeePct));
      const fallbackProfitability = await profitClient.isFillProfitable(
        deposit,
        destinationChainLpFeePct,
        hubPoolToken,
        destinationChainId
      );

      // If destination chain is profitable, then use the top preferred chain as a favor to the depositor
      // but log that we might be taking a loss. This is to not penalize an honest depositor who set their
      // fees according to the API that assumes destination chain repayment.
      if (fallbackProfitability.profitable) {
        preferredChain = preferredChainIds[0];
        const deltaRelayerFee = profitabilityData.relayerFeePct.sub(fallbackProfitability.netRelayerFeePct);
        // This is the delta in the gross relayer fee. If negative, then the destination chain would have had a higher
        // gross relayer fee, and therefore represents a virtual loss to the relayer. However, the relayer is
        // maintaining its inventory allocation by sticking to its preferred repayment chain.
        this.logger[this.config.sendingRelaysEnabled ? "info" : "debug"]({
          at: "Relayer::resolveRepaymentChain",
          message: `🦦 Taking repayment for filling deposit ${depositId} on preferred chains ${JSON.stringify(
            preferredChainIds
          )} is unprofitable but taking repayment on destination chain ${destinationChainId} is profitable. Electing to take repayment on top preferred chain ${preferredChain} as favor to depositor who assumed repayment on destination chain in their quote. Delta in net relayer fee: ${formatFeePct(
            deltaRelayerFee
          )}%`,
          deposit: {
            originChain,
            destinationChain,
            token: hubPoolToken.symbol,
            txnHash: blockExplorerLink(transactionHash, originChainId),
          },
          preferredChain: getNetworkName(preferredChain),
          preferredChainLpFeePct: `${formatFeePct(profitabilityData.lpFeePct)}%`,
          destinationChainLpFeePct: `${formatFeePct(destinationChainLpFeePct)}%`,
          // The delta will cut into the gross relayer fee. If negative, then taking the repayment on destination chain
          // would have been more profitable to the relayer because the lp fee would have been lower.
          deltaLpFeePct: `${formatFeePct(destinationChainLpFeePct.sub(profitabilityData.lpFeePct))}%`,
          // relayer fee is the gross relayer fee using the destination chain lp fee: inputAmount - outputAmount - lpFee.
          preferredChainRelayerFeePct: `${formatFeePct(profitabilityData.relayerFeePct)}%`,
          destinationChainRelayerFeePct: `${formatFeePct(fallbackProfitability.netRelayerFeePct)}%`,
          deltaRelayerFee: `${formatFeePct(deltaRelayerFee)}%`,
        });
      } else {
        // If preferred chain is not profitable and neither is fallback, then return the original profitability result.
        this.logger.debug({
          at: "Relayer::resolveRepaymentChain",
          message: `Taking repayment for deposit ${depositId} with preferred chains ${JSON.stringify(
            preferredChainIds
          )} on destination chain ${destinationChainId} would also not be profitable.`,
          deposit: {
            originChain,
            depositId,
            destinationChain,
            transactionHash,
            token: hubPoolToken.symbol,
            inputAmount,
            outputAmount,
          },
          preferredChain: getNetworkName(preferredChainIds[0]),
          preferredChainLpFeePct: `${formatFeePct(profitabilityData.lpFeePct)}%`,
          destinationChainLpFeePct: `${formatFeePct(destinationChainLpFeePct)}%`,
          preferredChainRelayerFeePct: `${formatFeePct(profitabilityData.relayerFeePct)}%`,
          destinationChainRelayerFeePct: `${formatFeePct(fallbackProfitability.netRelayerFeePct)}%`,
        });
      }
    }

    return {
      repaymentChainProfitability: profitabilityData,
      repaymentChainId: preferredChain,
    };
  }

  private handleTokenShortfall() {
    const tokenShortfall = this.clients.tokenClient.getTokenShortfall();
    const hubChainId = this.clients.hubPoolClient.chainId;

    let mrkdwn = "";
    Object.entries(tokenShortfall).forEach(([_chainId, shortfallForChain]) => {
      const chainId = Number(_chainId);
      mrkdwn += `*Shortfall on ${getNetworkName(chainId)}:*\n`;
      Object.entries(shortfallForChain).forEach(([token, { shortfall, balance, needed, deposits }]) => {
        const { symbol, formatter } = this.formatAmount(chainId, token);
        let crossChainLog = "";
        if (this.clients.inventoryClient.isInventoryManagementEnabled() && chainId !== hubChainId) {
          // Shortfalls are mapped to deposit output tokens so look up output token in token symbol map.
          const l1Token = this.clients.hubPoolClient.getL1TokenInfoForAddress(token, chainId);
          crossChainLog =
            "There is " +
            formatter(
              this.clients.inventoryClient.crossChainTransferClient
                .getOutstandingCrossChainTransferAmount(this.relayerAddress, chainId, l1Token.address, token)
                // TODO: Add in additional l2Token param here once we can specify it
                .toString()
            ) +
            ` inbound L1->L2 ${symbol} transfers. `;
        }
        mrkdwn +=
          ` - ${symbol} cumulative shortfall of ` +
          `${formatter(shortfall.toString())} ` +
          `(have ${formatter(balance.toString())} but need ` +
          `${formatter(needed.toString())}). ${crossChainLog}` +
          `This is blocking deposits: ${deposits}.\n`;
      });
    });

    this.logger[this.config.sendingRelaysEnabled ? "warn" : "debug"]({
      at: "Relayer::handleTokenShortfall",
      message: "Insufficient balance to fill all deposits 💸!",
      mrkdwn,
    });
  }

  private formatAmount(
    chainId: number,
    tokenAddress: string
  ): { symbol: string; decimals: number; formatter: (amount: string) => string } {
    const { symbol, decimals } = this.clients.hubPoolClient.getTokenInfoForAddress(tokenAddress, chainId);
    return { symbol, decimals, formatter: createFormatFunction(2, 4, false, decimals) };
  }

  private handleUnprofitableFill() {
    const { profitClient } = this.clients;
    const unprofitableDeposits = profitClient.getUnprofitableFills();

    let mrkdwn = "";
    Object.keys(unprofitableDeposits).forEach((chainId) => {
      let depositMrkdwn = "";
      Object.keys(unprofitableDeposits[chainId]).forEach((depositId) => {
        const { deposit, lpFeePct, relayerFeePct, gasCost } = unprofitableDeposits[chainId][depositId];

        // Skip notifying if the unprofitable fill happened too long ago to avoid spamming.
        if (deposit.quoteTimestamp + UNPROFITABLE_DEPOSIT_NOTICE_PERIOD < getCurrentTime()) {
          return;
        }

        const { originChainId, destinationChainId, inputToken, outputToken, inputAmount, outputAmount } = deposit;
        const depositblockExplorerLink = blockExplorerLink(deposit.transactionHash, originChainId);
        const { symbol: inputSymbol, formatter: inputFormatter } = this.formatAmount(originChainId, inputToken);
        const formattedInputAmount = inputFormatter(inputAmount.toString());
        const { symbol: outputSymbol, formatter: outputFormatter } = this.formatAmount(destinationChainId, outputToken);
        const formattedOutputAmount = outputFormatter(outputAmount.toString());

        const { symbol: gasTokenSymbol, decimals: gasTokenDecimals } = profitClient.resolveGasToken(destinationChainId);
        const formattedGasCost = createFormatFunction(2, 10, false, gasTokenDecimals)(gasCost.toString());
        const formattedRelayerFeePct = formatFeePct(relayerFeePct);
        const formattedLpFeePct = formatFeePct(lpFeePct);

        depositMrkdwn +=
          `- DepositId ${deposit.depositId} (tx: ${depositblockExplorerLink})` +
          ` of input amount ${formattedInputAmount} ${inputSymbol}` +
          ` and output amount ${formattedOutputAmount} ${outputSymbol}` +
          ` from ${getNetworkName(originChainId)} to ${getNetworkName(destinationChainId)}` +
          ` with relayerFeePct ${formattedRelayerFeePct}%, lpFeePct ${formattedLpFeePct}%,` +
          ` and gas cost ${formattedGasCost} ${gasTokenSymbol} is unprofitable!\n`;
      });

      if (depositMrkdwn) {
        mrkdwn += `*Unprofitable deposits on ${getNetworkName(chainId)}:*\n` + depositMrkdwn;
      }
    });

    if (mrkdwn) {
      this.logger[this.config.sendingRelaysEnabled ? "warn" : "debug"]({
        at: "Relayer::handleUnprofitableFill",
        message: "Not relaying unprofitable deposits 🙅‍♂️!",
        mrkdwn,
      });
    }
  }

  private constructRelayFilledMrkdwn(
    deposit: V3Deposit,
    repaymentChainId: number,
    realizedLpFeePct: BigNumber
  ): string {
    let mrkdwn =
      this.constructBaseFillMarkdown(deposit, realizedLpFeePct) +
      ` Relayer repayment: ${getNetworkName(repaymentChainId)}.`;

    if (isDepositSpedUp(deposit)) {
      const { symbol, decimals } = this.clients.hubPoolClient.getTokenInfo(
        deposit.destinationChainId,
        deposit.outputToken
      );
      const updatedOutputAmount = createFormatFunction(2, 4, false, decimals)(deposit.updatedOutputAmount.toString());
      mrkdwn += ` Reduced output amount: ${updatedOutputAmount} ${symbol}.`;
    }

    return mrkdwn;
  }

  private constructBaseFillMarkdown(deposit: V3Deposit, _realizedLpFeePct: BigNumber): string {
    const { symbol, decimals } = this.clients.hubPoolClient.getTokenInfoForDeposit(deposit);
    const srcChain = getNetworkName(deposit.originChainId);
    const dstChain = getNetworkName(deposit.destinationChainId);
    const depositor = blockExplorerLink(deposit.depositor, deposit.originChainId);
    const inputAmount = createFormatFunction(2, 4, false, decimals)(deposit.inputAmount.toString());

    let msg = `Relayed depositId ${deposit.depositId} from ${srcChain} to ${dstChain} of ${inputAmount} ${symbol}`;
    const realizedLpFeePct = formatFeePct(_realizedLpFeePct);
    const _totalFeePct = deposit.inputAmount
      .sub(deposit.outputAmount)
      .mul(fixedPointAdjustment)
      .div(deposit.inputAmount);
    const totalFeePct = formatFeePct(_totalFeePct);
    const { symbol: outputTokenSymbol, decimals: outputTokenDecimals } =
      this.clients.hubPoolClient.getTokenInfoForAddress(deposit.outputToken, deposit.destinationChainId);
    const _outputAmount = createFormatFunction(2, 4, false, outputTokenDecimals)(deposit.outputAmount.toString());
    msg +=
      ` and output ${_outputAmount} ${outputTokenSymbol}, with depositor ${depositor}.` +
      ` Realized LP fee: ${realizedLpFeePct}%, total fee: ${totalFeePct}%.`;

    return msg;
  }
}

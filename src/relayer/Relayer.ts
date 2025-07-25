import assert from "assert";
import { utils as sdkUtils, arch } from "@across-protocol/sdk";
import { utils as ethersUtils } from "ethers";
import { FillStatus, Deposit, DepositWithBlock } from "../interfaces";
import { updateSpokePoolClients } from "../common";
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
  Profiler,
  formatGwei,
  depositForcesOriginChainRepayment,
  isEVMSpokePoolClient,
  isSVMSpokePoolClient,
  Address,
  toAddressType,
  EvmAddress,
  CHAIN_IDs,
  convertRelayDataParamsToBytes32,
  chainIsSvm,
} from "../utils";
import { RelayerClients } from "./RelayerClientHelper";
import { RelayerConfig } from "./RelayerConfig";
import { MultiCallerClient } from "../clients";

const { getAddress } = ethersUtils;
const { isDepositSpedUp, isMessageEmpty, resolveDepositMessage } = sdkUtils;
const UNPROFITABLE_DEPOSIT_NOTICE_PERIOD = 60 * 60; // 1 hour
const RELAYER_DEPOSIT_RATE_LIMIT = 25;
const HUB_SPOKE_BLOCK_LAG = 2; // Permit SpokePool timestamps to be ahead of the HubPool by 2 HubPool blocks.

type RepaymentFee = { paymentChainId: number; lpFeePct: BigNumber };
type BatchLPFees = { [depositKey: string]: RepaymentFee[] };
type RepaymentChainProfitability = {
  gasLimit: BigNumber;
  gasCost: BigNumber;
  gasPrice: BigNumber;
  relayerFeePct: BigNumber;
  lpFeePct: BigNumber;
};

export class Relayer {
  public readonly relayerEvmAddress: Address;
  public readonly fillStatus: { [depositHash: string]: number } = {};
  private pendingTxnHashes: { [chainId: number]: Promise<string[]> } = {};
  private lastLogTime = 0;
  private lastMaintenance = 0;
  private profiler: InstanceType<typeof Profiler>;
  private hubPoolBlockBuffer: number;
  protected fillLimits: { [originChainId: number]: { fromBlock: number; limit: BigNumber }[] };
  protected ignoredDeposits: { [depositHash: string]: boolean } = {};
  protected inventoryChainIds: number[];
  protected updated = 0;

  constructor(
    relayerEvmAddress: string,
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
    this.profiler = new Profiler({
      at: "Relayer",
      logger: this.logger,
    });
    // Hardcode an EVM chain ID, since the relayer address stored here is an EVM address.
    this.relayerEvmAddress = toAddressType(getAddress(relayerEvmAddress), CHAIN_IDs.MAINNET);
    this.inventoryChainIds =
      this.config.pollingDelay === 0 ? Object.values(clients.spokePoolClients).map(({ chainId }) => chainId) : [];
  }

  /**
   * @description Perform one-time relayer init. Handle (for example) token approvals.
   */
  async init(): Promise<void> {
    const { inventoryClient, tokenClient } = this.clients;
    await Promise.all([
      this.config.update(this.logger), // Update address filter.
      tokenClient.update(),
    ]);

    if (this.config.sendingRelaysEnabled && this.config.sendingTransactionsEnabled) {
      await tokenClient.setOriginTokenApprovals();
    }

    if (this.config.sendingRebalancesEnabled && this.config.sendingTransactionsEnabled) {
      await inventoryClient.setTokenApprovals();
    }

    this.logger.debug({
      at: "Relayer::init",
      message: "Completed one-time init.",
      relayerEvmAddress: this.relayerEvmAddress.toNative(),
      relayerSvmAddress: tokenClient.relayerSvmAddress.toNative(),
    });
  }

  /**
   * @description Perform per-loop updates.
   * @return True if all SpokePoolClients updated successfully, otherwise false.
   */
  async update(): Promise<boolean> {
    const {
      acrossApiClient,
      configStoreClient,
      hubPoolClient,
      inventoryClient,
      profitClient,
      spokePoolClients,
      tokenClient,
    } = this.clients;

    // Some steps can be skipped on the first run.
    if (this.updated++ > 0) {
      // Clear state from profit and token clients. These should start fresh on each iteration.
      profitClient.clearUnprofitableFills();
      tokenClient.clearTokenShortfall();
      tokenClient.clearTokenData();

      await configStoreClient.update();
      if (configStoreClient.latestHeightSearched > hubPoolClient.latestHeightSearched) {
        await hubPoolClient.update();
      }
    }

    await updateSpokePoolClients(spokePoolClients, [
      "FundsDeposited",
      "RequestedSpeedUpDeposit",
      "FilledRelay",
      "RelayedRootBundle",
      "ExecutedRelayerRefundRoot",
    ]);

    await Promise.all([
      acrossApiClient.update(this.config.ignoreLimits),
      inventoryClient.update(this.inventoryChainIds),
      tokenClient.update(),
    ]);

    return Object.values(spokePoolClients).every((spokePoolClient) => spokePoolClient.isUpdated);
  }

  /**
   * @description Perform inventory management as needed. This is capped to 1/minute in looping mode.
   */
  async runMaintenance(): Promise<void> {
    const { inventoryClient, profitClient, tokenClient } = this.clients;

    const currentTime = getCurrentTime();
    if (currentTime < this.lastMaintenance + this.config.maintenanceInterval) {
      return; // Nothing to do.
    }

    tokenClient.clearTokenData();
    await Promise.all([tokenClient.update(), profitClient.update()]);
    await inventoryClient.wrapL2EthIfAboveThreshold();

    if (this.config.sendingRebalancesEnabled) {
      // It's necessary to update token balances in case WETH was wrapped.
      tokenClient.clearTokenData();
      await tokenClient.update();
      await inventoryClient.rebalanceInventoryIfNeeded();
      await inventoryClient.withdrawExcessBalances();
    }

    // Unwrap WETH after filling deposits, but before rebalancing.
    await inventoryClient.unwrapWeth();

    // Flush any stale state (i.e. deposit/fill events that are outside of the configured lookback window?)
    this.ignoredDeposits = {};

    // May be less than maintenanceInterval if these blocking calls are slow.
    this.lastMaintenance = currentTime;

    this.logger.debug({
      at: "Relayer::runMaintenance",
      message: "Completed relayer maintenance.",
    });
  }

  fillIsExclusive(deposit: Deposit): boolean {
    const currentTime = this.clients.spokePoolClients[deposit.destinationChainId].getCurrentTime();
    return deposit.exclusivityDeadline >= currentTime;
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
    const { addressFilter, ignoreLimits, relayerTokens, acceptInvalidFills, minDepositConfirmations } = this.config;
    const [srcChain, dstChain] = [getNetworkName(originChainId), getNetworkName(destinationChainId)];
    const relayKey = sdkUtils.getRelayEventKey(deposit);

    // Helper to mark a deposit as filled. This is useful when it should not be considered in future loops
    // i.e. because it is inherently un-fillable given the current runtime configuration.
    const ignoreDeposit = (): boolean => {
      this.ignoredDeposits[relayKey] = true;
      return false;
    };

    // Deposit has previously been ignored.
    if (this.ignoredDeposits[relayKey]) {
      return false;
    }

    // If we don't have the latest code to support this deposit, skip it.
    if (depositVersion > configStoreClient.configStoreVersion) {
      this.logger.warn({
        at: "Relayer::filterDeposit",
        message: "Skipping deposit that is not supported by this relayer version.",
        latestVersionSupported: configStoreClient.configStoreVersion,
        latestInConfigStore: configStoreClient.getConfigStoreVersionForTimestamp(),
        deposit: convertRelayDataParamsToBytes32(deposit),
      });
      return ignoreDeposit();
    }

    if (sdkUtils.invalidOutputToken(deposit)) {
      this.logger.debug({
        at: "Relayer::filterDeposit",
        message: `Skipping ${srcChain} deposit for invalid output token ${deposit.outputToken}.`,
        txnRef: deposit.txnRef,
      });
      return ignoreDeposit();
    }

    if (!this.routeEnabled(originChainId, destinationChainId)) {
      this.logger.debug({
        at: "Relayer::filterDeposit",
        message: "Skipping deposit from or to disabled chains.",
        deposit: convertRelayDataParamsToBytes32(deposit),
        enabledOriginChains: this.config.relayerOriginChains,
        enabledDestinationChains: this.config.relayerDestinationChains,
      });
      return ignoreDeposit();
    }

    const badOriginChainAddrs = [deposit.depositor, deposit.inputToken].some((address) => {
      return !address.isValidOn(deposit.originChainId);
    });
    const badDestChainAddrs = [deposit.recipient, deposit.exclusiveRelayer, deposit.outputToken].some((address) => {
      return !address.isValidOn(deposit.destinationChainId);
    });
    if (badOriginChainAddrs || badDestChainAddrs) {
      this.logger.debug({
        at: "Relayer::filterDeposit",
        message: `Skipping ${srcChain} deposit due to invalid address.`,
        deposit: convertRelayDataParamsToBytes32(deposit),
      });
      return ignoreDeposit();
    }

    if (addressFilter?.has(depositor.toNative()) || addressFilter?.has(recipient.toNative())) {
      this.logger.debug({
        at: "Relayer::filterDeposit",
        message: `Ignoring ${srcChain} deposit destined for ${dstChain}.`,
        depositor: depositor.toNative(),
        recipient: recipient.toNative(),
        txnRef: deposit.txnRef,
      });
      return ignoreDeposit();
    }

    // Skip any L1 tokens that are not specified in the config.
    // If relayerTokens is an empty list, we'll assume that all tokens are supported.
    const l1Token = this.clients.inventoryClient.getL1TokenAddress(inputToken, originChainId);
    if (relayerTokens.length > 0 && !relayerTokens.some((token) => token.eq(l1Token))) {
      this.logger.debug({
        at: "Relayer::filterDeposit",
        message: "Skipping deposit for unwhitelisted token",
        deposit: convertRelayDataParamsToBytes32(deposit),
        l1Token: l1Token.toNative(),
      });
      return ignoreDeposit();
    }

    // Skip deposits with unmatching input/output tokens.
    if (!this.clients.inventoryClient.validateOutputToken(deposit)) {
      this.logger.debug({
        at: "Relayer::filterDeposit",
        message: "Skipping deposit including in-protocol token swap.",
        originChainId,
        destinationChainId,
        outputToken: deposit.outputToken.toNative(),
        txnRef: deposit.txnRef,
        notificationPath: "across-unprofitable-fills",
      });
      return ignoreDeposit();
    }

    // Ensure that the individual deposit meets the minimum deposit confirmation requirements for its value.
    const fillAmountUsd = profitClient.getFillAmountInUsd(deposit);
    if (!isDefined(fillAmountUsd)) {
      this.logger.debug({
        at: "Relayer::filterDeposit",
        message: `Skipping ${srcChain} deposit due to uncertain fill amount.`,
        destinationChainId,
        outputToken: deposit.outputToken.toNative(),
        txnRef: deposit.txnRef,
      });
      return ignoreDeposit();
    }

    // Skip deposit with message if sending fills with messages is not supported.
    if (!this.config.sendingMessageRelaysEnabled && !isMessageEmpty(resolveDepositMessage(deposit))) {
      this.logger[this.config.sendingRelaysEnabled ? "warn" : "debug"]({
        at: "Relayer::filterDeposit",
        message: "Skipping fill for deposit with message",
        depositUpdated: isDepositSpedUp(deposit),
        deposit: convertRelayDataParamsToBytes32(deposit),
      });
      return ignoreDeposit();
    }

    // Skip deposits that contain invalid fills from the same relayer. This prevents potential corrupted data from
    // making the same relayer fill a deposit multiple times.
    if (
      !acceptInvalidFills &&
      invalidFills.some((fill) => fill.relayer.eq(this.getRelayerAddrOn(fill.destinationChainId)))
    ) {
      this.logger.error({
        at: "Relayer::filterDeposit",
        message: "👨‍👧‍👦 Skipping deposit with invalid fills from the same relayer",
        deposit: convertRelayDataParamsToBytes32(deposit),
        invalidFills,
        destinationChainId,
      });
      return ignoreDeposit();
    }

    // It would be preferable to use host time since it's more reliably up-to-date, but this creates issues in test.
    const currentTime = spokePoolClients[destinationChainId].getCurrentTime();
    if (deposit.fillDeadline <= currentTime) {
      return ignoreDeposit();
    }

    const { minConfirmations } = minDepositConfirmations[originChainId].find(({ usdThreshold }) =>
      usdThreshold.gte(fillAmountUsd)
    ) ?? { minConfirmations: 100_000 };
    const { latestHeightSearched } = spokePoolClients[originChainId];
    if (latestHeightSearched - blockNumber < minConfirmations) {
      this.logger.debug({
        at: "Relayer::filterDeposit",
        message: `Skipping ${srcChain} deposit due to insufficient deposit confirmations.`,
        depositId: depositId.toString(),
        blockNumber,
        confirmations: latestHeightSearched - blockNumber,
        minConfirmations,
        txnRef: deposit.txnRef,
      });
      return false;
    }

    // Skip deposits with quoteTimestamp in the future (impossible to know HubPool utilization => LP fee cannot be computed).
    if (deposit.quoteTimestamp - hubPoolClient.currentTime > this.hubPoolBlockBuffer) {
      this.logger.debug({
        at: "Relayer::filterDeposit",
        message: `Skipping ${srcChain} deposit due to future quoteTimestamp.`,
        currentTime: hubPoolClient.currentTime,
        quoteTimestamp: deposit.quoteTimestamp,
        buffer: this.hubPoolBlockBuffer,
        txnRef: deposit.txnRef,
      });
      return false;
    }

    if (
      this.fillIsExclusive(deposit) &&
      !deposit.exclusiveRelayer.eq(this.getRelayerAddrOn(deposit.destinationChainId))
    ) {
      return false;
    }

    // We query the relayer API to get the deposit limits for different token and origin combinations.
    // The relayer should *not* be filling deposits that the HubPool doesn't have liquidity for otherwise the relayer's
    // refund will be stuck for potentially 7 days. Note: Filter for supported tokens first, since the relayer only
    // queries for limits on supported tokens.
    if (!ignoreLimits && !depositForcesOriginChainRepayment(deposit, hubPoolClient)) {
      const { inputAmount } = deposit;
      const limit = acrossApiClient.getLimit(originChainId, l1Token);
      if (acrossApiClient.updatedLimits && inputAmount.gt(limit)) {
        this.logger.warn({
          at: "Relayer::filterDeposit",
          message: "😱 Skipping deposit with greater unfilled amount than API suggested limit",
          limit,
          l1Token: l1Token.toNative(),
          depositId: depositId.toString(),
          inputToken: inputToken.toNative(),
          inputAmount,
          originChainId,
          txnRef: deposit.txnRef,
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

  /**
   * For a given origin chain, find the relevant fill limit based on a deposit block number.
   * @param originChainId Chain ID of origin chain.
   * @param blockNumber Block number for the deposit to be filled.
   * @returns An index into the limits array.
   */
  findOriginChainLimitIdx(originChainId: number, blockNumber: number): number {
    const limits = this.fillLimits[originChainId];

    // Find the uppermost USD threshold compatible with the age of the origin chain deposit.
    // @todo: Swap out for Array.findLastIndex() when available.
    let idx = 0;
    while (idx < limits.length && limits[idx].fromBlock > blockNumber) {
      ++idx;
    }

    // If no config applies to the blockNumber (i.e. because it's too old), just return the uppermost limit.
    return Math.min(idx, limits.length - 1);
  }

  /**
   * For a given origin chain, determine whether a new fill will overcommit the chain.
   * @param originChainId Chain ID of origin chain.
   * @param amount USD amount to evaluate.
   * @param limitIdx Optional index into fillLimits to narrow the evaluation.
   * @returns An index into the limits array.
   */
  originChainOvercommitted(originChainId: number, amount = bnZero, limitIdx = 0): boolean {
    const fillLimits = this.fillLimits[originChainId].slice(limitIdx);
    return fillLimits?.some(({ limit }) => limit.sub(amount).lt(bnZero)) ?? true;
  }

  /**
   * For a given origin chain, reduce its origin chain limits by `amount`.
   * @param originChainId Chain ID of origin chain.
   * @param amount USD amount to reduce the limit by.
   * @param limitIdx Optional index into fillLimits to narrow the update.
   */
  reduceOriginChainLimit(originChainId: number, amount: BigNumber, limitIdx = 0): void {
    const limits = this.fillLimits[originChainId];
    for (let i = limitIdx; i < limits.length; ++i) {
      limits[i].limit = limits[i].limit.sub(amount);
    }
  }

  /**
   * For a given origin chain block range, sum the USD value of any fills made by this relayer.
   * @param chainId Origin chain ID to inspect.
   * @param fromBlock Origin chain block number lower bound.
   * @param toBlock Origin chain block number upper bound.
   * @returns The cumulative USD value of fills made by this relayer for deposits within the specified block range.
   */
  computeOriginChainCommitment(chainId: number, fromBlock: number, toBlock: number): BigNumber {
    const { profitClient, spokePoolClients } = this.clients;
    const originSpoke = spokePoolClients[chainId];

    const deposits = originSpoke.getDeposits({ fromBlock, toBlock });
    const commitment = deposits.reduce((acc, deposit) => {
      const fill = spokePoolClients[deposit.destinationChainId]
        ?.getFillsForDeposit(deposit)
        ?.find((f) => f.relayer.eq(this.getRelayerAddrOn(f.destinationChainId)));
      if (!isDefined(fill)) {
        return acc;
      }

      const fillAmount = profitClient.getFillAmountInUsd(deposit);
      return acc.add(fillAmount ?? bnZero);
    }, bnZero);

    return commitment;
  }

  /**
   * For a given origin chain, map the relayer's deposit confirmation requirements to tiered USD amounts that can be
   * filled by this relayer.
   * @param chainId Origin chain ID to inspect.
   * @returns An array of origin chain fill limits in USD, ordered by origin chain block range.
   */
  computeOriginChainLimits(chainId: number): { fromBlock: number; limit: BigNumber }[] {
    const mdcs = this.config.minDepositConfirmations[chainId];
    const originSpoke = this.clients.spokePoolClients[chainId];

    let totalCommitment = bnZero;
    let toBlock = originSpoke.latestHeightSearched;

    // For each deposit confirmation tier (lookback), sum all outstanding commitments back to head.
    const limits = mdcs.map(({ usdThreshold, minConfirmations }) => {
      const fromBlock = Math.max(toBlock - minConfirmations, originSpoke.deploymentBlock);
      const commitment = this.computeOriginChainCommitment(chainId, fromBlock, toBlock);

      totalCommitment = totalCommitment.add(commitment);
      const limit = usdThreshold.sub(totalCommitment);
      toBlock = fromBlock - 1; // Shuffle the range for the next loop.

      return { fromBlock, limit };
    });

    // Warn on the highest overcommitment, if any.
    const chain = getNetworkName(chainId);
    for (let i = limits.length - 1; i >= 0; --i) {
      const { limit, fromBlock } = limits[i];
      if (limit.lt(bnZero)) {
        const log = this.config.sendingRelaysEnabled ? this.logger.warn : this.logger.debug;
        log({
          at: "Relayer::computeOriginChainlimits",
          message: `Relayer has overcommitted funds to ${chain}.`,
          overCommitment: limit.abs(),
          usdThreshold: mdcs[i].usdThreshold,
          fromBlock,
          toBlock: originSpoke.latestHeightSearched,
        });
        break;
      }
    }

    // Safety belt: limits should descending by fromBlock (i.e. most recent block first).
    // Equality is permitted if the lookback is bounded by the SpokePool deployment block,
    // or if the origin spoke has not yet updated.
    limits.slice(1).forEach(({ fromBlock }, idx) => {
      const { fromBlock: prevFromBlock } = limits[idx];
      assert(
        prevFromBlock > fromBlock || fromBlock === originSpoke.deploymentBlock,
        `${chainId} fill limits inconsistency (${fromBlock} >= ${prevFromBlock})`
      );
    });

    return limits;
  }

  /**
   * For all origin chains, map the relayer's deposit confirmation requirements to tiered USD amounts that can be
   * filled by this relayer.
   * @returns A mapping of chain ID to an array of origin chain fill limits in USD, ordered by origin chain block range.
   */
  computeFillLimits(): { [originChainId: number]: { fromBlock: number; limit: BigNumber }[] } {
    // For each SpokePool reduce the amount available for fills by the amount
    // previously committed within the origin chain's finality window.
    const limits = Object.fromEntries(
      Object.values(this.clients.spokePoolClients).map(({ chainId: originChainId }) => {
        const limits = this.computeOriginChainLimits(originChainId);
        return [originChainId, limits];
      })
    );
    this.logger.debug({ at: "Relayer::computeFillLimits", message: "Computed origin chain fill limits.", limits });

    return limits;
  }

  // @node: This method is flagged for removal after computeFillLimits() has been proven.
  computeRequiredDepositConfirmations(deposits: Deposit[], destinationChainId: number): { [chainId: number]: number } {
    const { profitClient, tokenClient } = this.clients;
    const { minDepositConfirmations } = this.config;

    // Sum the total unfilled deposit amount per origin chain and set a MDC for that chain.
    // Filter out deposits where the relayer doesn't have the balance to make the fill.
    const unfilledDepositAmountsPerChain: { [chainId: number]: BigNumber } = deposits
      .filter((deposit) => tokenClient.hasBalanceForFill(deposit))
      .reduce((agg, deposit) => {
        const unfilledAmountUsd = profitClient.getFillAmountInUsd(deposit);
        agg[deposit.originChainId] = (agg[deposit.originChainId] ?? bnZero).add(unfilledAmountUsd ?? bnZero);
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
    deposit: DepositWithBlock,
    fillStatus: number,
    lpFees: RepaymentFee[],
    maxBlockNumber: number,
    sendSlowRelays: boolean
  ): Promise<void> {
    const { depositId, depositor, destinationChainId, originChainId, inputToken, txnRef } = deposit;
    const { profitClient, spokePoolClients, tokenClient } = this.clients;
    const { slowDepositors } = this.config;
    const [originChain, destChain] = [getNetworkName(originChainId), getNetworkName(destinationChainId)];

    if (isDefined(this.pendingTxnHashes[destinationChainId])) {
      this.logger.info({
        at: "Relayer::evaluateFill",
        message: `${destChain} transaction queue has pending fills; skipping ${originChain} deposit ${depositId.toString()}...`,
        originChainId,
        txnRef,
      });
      return;
    }

    // If the deposit does not meet the minimum number of block confirmations, skip it.
    if (deposit.blockNumber > maxBlockNumber) {
      this.logger.debug({
        at: "Relayer::evaluateFill",
        message: `Skipping ${originChain} deposit ${depositId.toString()} due to insufficient deposit confirmations.`,
        blockNumber: deposit.blockNumber,
        maxBlockNumber,
        txnRef,
      });
      // If we're in simulation mode, skip this early exit so that the user can evaluate
      // the full simulation run.
      if (this.config.sendingTransactionsEnabled) {
        return;
      }
    }

    // If depositor is on the slow deposit list, then send a zero fill to initiate a slow relay and return early.
    if (slowDepositors?.some((slowDepositor) => depositor.eq(slowDepositor))) {
      if (fillStatus === FillStatus.Unfilled && !this.fillIsExclusive(deposit)) {
        this.logger.debug({
          at: "Relayer::evaluateFill",
          message: "Initiating slow fill for grey listed depositor",
          depositor,
        });
        this.requestSlowFill(deposit);
      }
      return;
    }

    // If the operator configured a minimum fill time for a destination chain, ensure that the deposit
    // is at least that old before filling it. This is mainly useful on chains with long block times,
    // where there is a high chance of fill collisions in the first blocks after a deposit is made.
    const minFillTime = this.config.minFillTime?.[destinationChainId] ?? 0;
    if (minFillTime > 0 && !deposit.exclusiveRelayer.eq(this.getRelayerAddrOn(deposit.destinationChainId))) {
      const originSpoke = spokePoolClients[originChainId];
      let avgBlockTime;
      if (isEVMSpokePoolClient(originSpoke)) {
        const { average } = await arch.evm.averageBlockTime(originSpoke.spokePool.provider);
        avgBlockTime = average;
      } else if (isSVMSpokePoolClient(originSpoke)) {
        const { average } = await arch.svm.averageBlockTime();
        avgBlockTime = average;
      }
      const depositAge = Math.floor(avgBlockTime * (originSpoke.latestHeightSearched - deposit.blockNumber));

      if (minFillTime > depositAge) {
        this.logger.debug({
          at: "Relayer::evaluateFill",
          message: `Skipping ${originChain} deposit due to insufficient fill time for ${destChain}.`,
          depositAge,
          minFillTime,
          txnRef,
        });
        return;
      }
    }

    const l1Token = this.clients.inventoryClient.getL1TokenAddress(inputToken, originChainId);
    if (tokenClient.hasBalanceForFill(deposit)) {
      const { repaymentChainId, repaymentChainProfitability } = await this.resolveRepaymentChain(
        deposit,
        l1Token,
        lpFees
      );
      const {
        relayerFeePct,
        gasCost,
        gasLimit: _gasLimit,
        lpFeePct: realizedLpFeePct,
        gasPrice,
      } = repaymentChainProfitability;
      if (!isDefined(repaymentChainId)) {
        profitClient.captureUnprofitableFill(deposit, realizedLpFeePct, relayerFeePct, gasCost);
        const relayKey = sdkUtils.getRelayEventKey(deposit);
        this.ignoredDeposits[relayKey] = true;
      } else {
        const { blockNumber, outputToken, outputAmount } = deposit;
        const fillAmountUsd = profitClient.getFillAmountInUsd(deposit);
        if (!isDefined(fillAmountUsd)) {
          return;
        }
        const limitIdx = this.findOriginChainLimitIdx(originChainId, blockNumber);

        // Ensure that a limit was identified, and that no upper thresholds would be breached by filling this deposit.
        if (this.originChainOvercommitted(originChainId, fillAmountUsd, limitIdx)) {
          const limits = this.fillLimits[originChainId].slice(limitIdx);
          this.logger.debug({
            at: "Relayer::evaluateFill",
            message: `Skipping ${originChain} deposit ${depositId.toString()} due to anticipated origin chain overcommitment.`,
            blockNumber,
            fillAmountUsd,
            limits,
            txnRef,
          });
          return;
        }

        // Update the origin chain limits in anticipation of committing tokens to a fill.
        this.reduceOriginChainLimit(originChainId, fillAmountUsd, limitIdx);

        // Update local balance to account for the enqueued fill.
        tokenClient.decrementLocalBalance(destinationChainId, outputToken, outputAmount);

        const gasLimit = isMessageEmpty(resolveDepositMessage(deposit)) ? undefined : _gasLimit;
        this.fillRelay(deposit, repaymentChainId, realizedLpFeePct, gasPrice, gasLimit);
      }
    } else {
      // Exit early if we want to request a slow fill for a lite chain.
      if (depositForcesOriginChainRepayment(deposit, this.clients.hubPoolClient)) {
        this.logger.debug({
          at: "Relayer::evaluateFill",
          message: "Skipping requesting slow fill for deposit that forces origin chain repayment",
          originChainId,
          depositId: depositId.toString(),
        });
        return;
      }
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
  getLPFeeKey(relayData: Pick<Deposit, "originChainId" | "inputToken" | "inputAmount" | "quoteTimestamp">): string {
    return `${relayData.originChainId}-${relayData.inputToken.toBytes32()}-${relayData.inputAmount}-${
      relayData.quoteTimestamp
    }`;
  }

  /**
   * For a given destination chain, evaluate and optionally fill each unfilled deposit. Note that each fill should be
   * evaluated sequentially in order to ensure atomic balance updates.
   * @param deposits An array of deposits destined for the same destination chain.
   * @param maxBlockNumbers A map of the highest block number per origin chain to fill.
   * @returns void
   */
  async evaluateFills(
    deposits: (DepositWithBlock & { fillStatus: number })[],
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
  async batchComputeLpFees(deposits: DepositWithBlock[]): Promise<BatchLPFees> {
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
    const fillExecutorClient = chainIsSvm(chainId) ? this.clients.svmFillerClient : this.getMulticaller(chainId);
    const { pendingTxnHashes } = this;

    if (isDefined(pendingTxnHashes[chainId])) {
      this.logger.info({
        at: "Relayer::executeFills",
        message: `${getNetworkName(chainId)} transaction queue has pending fills; skipping...`,
      });
      fillExecutorClient.clearTransactionQueue(chainId);
      return [];
    }
    pendingTxnHashes[chainId] = (async () => {
      return (await fillExecutorClient.executeTxnQueue(chainId, simulate)).map((response) => response.hash);
    })();
    const txnReceipts = await pendingTxnHashes[chainId];
    delete pendingTxnHashes[chainId];

    return txnReceipts;
  }

  async checkForUnfilledDepositsAndFill(
    sendSlowRelays = true,
    simulate = false
  ): Promise<{ [chainId: number]: Promise<string[]> }> {
    const { hubPoolClient, profitClient, spokePoolClients, tokenClient, multiCallerClient, tryMulticallClient } =
      this.clients;

    // Fetch the average block time for mainnet, for later use in evaluating quoteTimestamps.
    this.hubPoolBlockBuffer ??= Math.ceil(
      HUB_SPOKE_BLOCK_LAG * (await arch.evm.averageBlockTime(hubPoolClient.hubPool.provider)).average
    );

    // Flush any pre-existing enqueued transactions that might not have been executed.
    multiCallerClient.clearTransactionQueue();
    tryMulticallClient.clearTransactionQueue();
    // @dev `this.clients.svmFillerClient` is only defined if we have an SVM chain in enabled chains
    if (isDefined(this.clients.svmFillerClient)) {
      this.clients.svmFillerClient.clearTransactionQueue();
    }
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

    this.fillLimits = this.computeFillLimits();

    const lpFees = await this.batchComputeLpFees(allUnfilledDeposits);
    await sdkUtils.forEachAsync(Object.entries(unfilledDeposits), async ([chainId, _deposits]) => {
      if (_deposits.length === 0) {
        return;
      }

      const destinationChainId = Number(chainId);
      const deposits = _deposits.map(({ deposit }) => deposit);
      const fillStatus = await spokePoolClients[destinationChainId].fillStatusArray(deposits);

      // In looping mode, limit the number of deposits per chain per loop. This is an anti-spam mechanism that avoids
      // an activity surge on any single chain from significantly degrading overall performance. When running in
      // single-shot mode (pollingDelay 0), do not limit. This permits sweeper instances to work correctly.
      const depositLimit = this.config.pollingDelay === 0 ? deposits.length : RELAYER_DEPOSIT_RATE_LIMIT;
      const unfilledDeposits = deposits
        .map((deposit, idx) => ({ ...deposit, fillStatus: fillStatus[idx] }))
        .filter(({ fillStatus, ...deposit }) => {
          // Track the fill status for faster filtering on subsequent loops.
          const depositHash = spokePoolClients[deposit.destinationChainId].getDepositHash(deposit);
          this.fillStatus[depositHash] = fillStatus;
          return fillStatus !== FillStatus.Filled;
        })
        .slice(0, depositLimit);

      const mdcPerChain = this.computeRequiredDepositConfirmations(unfilledDeposits, destinationChainId);
      const maxBlockNumbers = Object.fromEntries(
        Object.values(spokePoolClients).map(({ chainId, latestHeightSearched }) => [
          chainId,
          latestHeightSearched - mdcPerChain[chainId],
        ])
      );

      await this.evaluateFills(unfilledDeposits, lpFees, maxBlockNumbers, sendSlowRelays);

      const pendingTxnCount = chainIsSvm(destinationChainId)
        ? this.clients.svmFillerClient.getTxnQueueLen()
        : this.getMulticaller(destinationChainId).getQueuedTransactions(destinationChainId).length;
      if (pendingTxnCount > 0) {
        txnReceipts[destinationChainId] = this.executeFills(destinationChainId, simulate);
      }
    });

    const currentTime = getCurrentTime();
    const logDeposits = this.config.loggingInterval < currentTime - this.lastLogTime;
    if (logDeposits) {
      if (tokenClient.anyCapturedShortFallFills()) {
        this.handleTokenShortfall();
        this.lastLogTime = currentTime;
      }
      if (profitClient.anyCapturedUnprofitableFills()) {
        this.handleUnprofitableFill();
        this.lastLogTime = currentTime;
      }
    }

    return txnReceipts;
  }

  /*
   * Manually update the fill status for a given deposit.
   * @note This protects against repeated attempts to fill on chains with longer confirmation times.
   * @param deposit Deposit object.
   * @param status Fill status (Unfilled, Filled, RequestedSlowFill).
   */
  protected setFillStatus(deposit: Deposit, status: number): void {
    const depositHash = this.clients.spokePoolClients[deposit.destinationChainId].getDepositHash(deposit);
    this.fillStatus[depositHash] = status;
  }

  requestSlowFill(deposit: Deposit): void {
    // don't request slow fill if origin/destination chain is a lite chain
    if (depositForcesOriginChainRepayment(deposit, this.clients.hubPoolClient) || deposit.toLiteChain) {
      this.logger.debug({
        at: "Relayer::requestSlowFill",
        message: "Prevent requesting slow fill request from chain that forces origin chain repayment or to lite chain.",
        deposit: convertRelayDataParamsToBytes32(deposit),
      });
      return;
    }

    // Verify that the _original_ message was empty, since that's what would be used in a slow fill. If a non-empty
    // message was nullified by an update, it can be full-filled but preferably not automatically zero-filled.
    if (!isMessageEmpty(deposit.message)) {
      this.logger[this.config.sendingRelaysEnabled ? "warn" : "debug"]({
        at: "Relayer::requestSlowFill",
        message: "Suppressing slow fill request for deposit with message.",
        deposit: convertRelayDataParamsToBytes32(deposit),
      });
      return;
    }

    const { hubPoolClient, spokePoolClients } = this.clients;
    const { originChainId, destinationChainId, depositId, outputToken } = deposit;
    const multiCallerClient = this.getMulticaller(destinationChainId);
    const spokePoolClient = spokePoolClients[destinationChainId];
    const slowFillRequest = spokePoolClient.getSlowFillRequest(deposit);
    if (isDefined(slowFillRequest)) {
      return; // Slow fill has already been requested; nothing to do.
    }

    const formatSlowFillRequestMarkdown = (): string => {
      const { symbol, decimals } = hubPoolClient.getTokenInfoForAddress(outputToken, destinationChainId);
      const formatter = createFormatFunction(2, 4, false, decimals);
      const outputAmount = formatter(deposit.outputAmount);
      const [srcChain, dstChain] = [getNetworkName(originChainId), getNetworkName(destinationChainId)];

      // @todo (future) infer the updated outputAmount by zeroing the relayer fee in order to print the correct amount.
      return (
        `Requested slow fill 🐌 of ${outputAmount} ${symbol}` +
        ` on ${dstChain} for ${srcChain} depositId ${depositId.toString()}.`
      );
    };

    this.logger.debug({ at: "Relayer::requestSlowFill", message: "Enqueuing slow fill request.", deposit });
    if (isEVMSpokePoolClient(spokePoolClient)) {
      multiCallerClient.enqueueTransaction({
        chainId: destinationChainId,
        contract: spokePoolClient.spokePool,
        method: "requestSlowFill",
        args: [convertRelayDataParamsToBytes32(deposit)],
        message: "Requested slow fill for deposit.",
        mrkdwn: formatSlowFillRequestMarkdown(),
      });
    } else {
      assert(isSVMSpokePoolClient(spokePoolClient));
      assert(spokePoolClient.spokePoolAddress.isSVM());

      const [recipient, outputToken] = [deposit.recipient, deposit.outputToken];
      if (!(recipient.isSVM() && outputToken.isSVM())) {
        // @dev recipient or outputToken are incorrectly formatted for the destination chain, drop deposit processing and log
        this.logger.debug({
          at: "Relayer",
          message: "Dropping slow fill request because recipient or outputToken are not valid SVM addresses.",
          originChainId: deposit.originChainId,
          depositId: deposit.depositId.toString(),
          destinationChainId: deposit.destinationChainId,
          recipient: recipient.toString(),
          outputToken: outputToken.toString(),
        });
        return;
      }

      this.clients.svmFillerClient.enqueueSlowFill(
        spokePoolClient.spokePoolAddress,
        { ...deposit, recipient, outputToken },
        "Requested slow fill for deposit.",
        formatSlowFillRequestMarkdown()
      );
    }
    this.setFillStatus(deposit, FillStatus.RequestedSlowFill);
  }

  fillRelay(
    deposit: Deposit,
    repaymentChainId: number,
    realizedLpFeePct: BigNumber,
    gasPrice: BigNumber,
    gasLimit?: BigNumber
  ): void {
    const { spokePoolClients } = this.clients;

    // If a deposit originates from a lite chain, then the repayment chain must be the origin chain.
    if (
      depositForcesOriginChainRepayment(deposit, this.clients.hubPoolClient) &&
      repaymentChainId !== deposit.originChainId
    ) {
      this.logger.warn({
        at: "Relayer::fillRelay",
        message: "Suppressed fill for deposit that forces origin chain repayment but repaymentChainId != originChainId",
        deposit: convertRelayDataParamsToBytes32(deposit),
        repaymentChainId,
      });
      return;
    }

    this.logger.debug({
      at: "Relayer::fillRelay",
      message: `Filling v3 deposit ${deposit.depositId.toString()} with repayment on ${repaymentChainId}.`,
      deposit: convertRelayDataParamsToBytes32(deposit),
      repaymentChainId,
      realizedLpFeePct,
    });

    const spokePoolClient = spokePoolClients[deposit.destinationChainId];
    if (isEVMSpokePoolClient(spokePoolClient)) {
      const [method, messageModifier, args] = !isDepositSpedUp(deposit)
        ? [
            "fillRelay",
            "",
            [
              convertRelayDataParamsToBytes32(deposit),
              repaymentChainId,
              this.getRelayerAddrOn(repaymentChainId).toBytes32(),
            ],
          ]
        : [
            "fillRelayWithUpdatedDeposit",
            " with updated parameters ",
            [
              convertRelayDataParamsToBytes32(deposit),
              repaymentChainId,
              this.getRelayerAddrOn(repaymentChainId).toBytes32(),
              deposit.updatedOutputAmount,
              deposit.updatedRecipient.toBytes32(),
              deposit.updatedMessage,
              deposit.speedUpSignature,
            ],
          ];

      const message = `Filled v3 deposit ${messageModifier}🚀`;
      const mrkdwn = this.constructRelayFilledMrkdwn(deposit, repaymentChainId, realizedLpFeePct, gasPrice);

      const contract = spokePoolClient.spokePool;
      const chainId = deposit.destinationChainId;
      const multiCallerClient = this.getMulticaller(chainId);

      multiCallerClient.enqueueTransaction({ contract, chainId, method, args, gasLimit, message, mrkdwn });
    } else {
      assert(isSVMSpokePoolClient(spokePoolClient));
      assert(spokePoolClient.spokePoolAddress.isSVM());
      const [recipient, outputToken] = [deposit.recipient, deposit.outputToken];
      if (!(recipient.isSVM() && outputToken.isSVM())) {
        // @dev recipient or outputToken are incorrectly formatted for the destination chain, drop deposit processing and log
        this.logger.debug({
          at: "Relayer",
          message: "Dropping fill request because recipient or outputToken are not valid SVM addresses.",
          originChainId: deposit.originChainId,
          depositId: deposit.depositId.toString(),
          destinationChainId: deposit.destinationChainId,
          recipient: recipient.toString(),
          outputToken: outputToken.toString(),
        });
        return;
      }

      const message = "Filled v3 deposit on SVM 🚀";
      const mrkdwn = this.constructRelayFilledMrkdwn(deposit, repaymentChainId, realizedLpFeePct, gasPrice);

      this.clients.svmFillerClient.enqueueFill(
        spokePoolClient.spokePoolAddress,
        {
          ...deposit,
          recipient: recipient,
          outputToken: outputToken,
        },
        repaymentChainId,
        this.getRelayerAddrOn(repaymentChainId),
        message,
        mrkdwn
      );
    }

    this.setFillStatus(deposit, FillStatus.Filled);
  }

  getRelayerAddrOn(repaymentChainId: number): Address {
    return chainIsSvm(repaymentChainId) ? this.clients.svmFillerClient.relayerAddress : this.relayerEvmAddress;
  }

  /**
   * @notice Returns repayment chain choice for deposit given repayment fees and the hubPoolToken associated with the
   * deposit inputToken.
   * @param deposit
   * @param hubPoolToken L1 token associated with the deposit inputToken.
   * @param repaymentFees
   * @returns repaymentChainId is defined if and only if a profitable repayment chain is found.
   * @returns repaymentChainProfitability contains the profitability data of the repaymentChainId if it is defined
   * or the profitability data of the most preferred repayment chain otherwise.
   */
  protected async resolveRepaymentChain(
    deposit: DepositWithBlock,
    hubPoolToken: EvmAddress,
    repaymentFees: RepaymentFee[]
  ): Promise<{
    repaymentChainId?: number;
    repaymentChainProfitability: RepaymentChainProfitability;
  }> {
    const { inventoryClient, profitClient } = this.clients;
    const { depositId, originChainId, destinationChainId, inputAmount, outputAmount, txnRef } = deposit;
    const originChain = getNetworkName(originChainId);
    const destinationChain = getNetworkName(destinationChainId);

    const mark = this.profiler.start("resolveRepaymentChain");
    const preferredChainIds = await inventoryClient.determineRefundChainId(deposit, hubPoolToken);
    if (preferredChainIds.length === 0) {
      // @dev If the origin chain is a lite chain and there are no preferred repayment chains, then we can assume
      // that the origin chain, the only possible repayment chain, is over-allocated. We should log this case because
      // it is a special edge case the relayer should be aware of.
      this.logger.debug({
        at: "Relayer::resolveRepaymentChain",
        message: depositForcesOriginChainRepayment(deposit, this.clients.hubPoolClient)
          ? `Deposit ${depositId.toString()} forces origin chain repayment and has an over-allocated origin chain ${originChain}`
          : `Unable to identify a preferred repayment chain for ${originChain} deposit ${depositId.toString()}.`,
        txn: blockExplorerLink(txnRef, originChainId),
      });
      return {
        repaymentChainProfitability: {
          gasLimit: bnZero,
          gasCost: bnUint256Max,
          gasPrice: bnUint256Max,
          relayerFeePct: bnZero,
          lpFeePct: bnUint256Max,
        },
      };
    }

    mark.stop({
      message: `Determined eligible repayment chains ${JSON.stringify(
        preferredChainIds
      )} for deposit ${depositId.toString()} from ${originChain} to ${destinationChain}.`,
      preferredChainIds,
      originChain,
      destinationChain,
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
    ): Promise<{
      profitable: boolean;
      gasLimit: BigNumber;
      gasCost: BigNumber;
      gasPrice: BigNumber;
      relayerFeePct: BigNumber;
    }> => {
      const {
        profitable,
        nativeGasCost: gasLimit,
        tokenGasCost: gasCost,
        gasPrice,
        netRelayerFeePct: relayerFeePct, // net relayer fee is equal to total fee minus the lp fee.
      } = await profitClient.isFillProfitable(deposit, lpFeePct, hubPoolToken, preferredChainId);
      return {
        profitable,
        gasLimit,
        gasCost,
        gasPrice,
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
      const { gasLimit, gasCost, relayerFeePct, gasPrice } = repaymentChainProfitabilities[preferredChainIndex];
      return {
        gasLimit,
        gasCost,
        gasPrice,
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
        message: `Selected preferred repayment chain ${preferredChain} for deposit ${depositId.toString()}, #${
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
    // Additionally we don't want to take this code path if the origin chain is a lite chain because we can't
    // reason about destination chain repayments on lite chains.
    if (
      !isDefined(preferredChain) &&
      !preferredChainIds.includes(destinationChainId) &&
      this.clients.inventoryClient.canTakeDestinationChainRepayment(deposit)
    ) {
      this.logger.debug({
        at: "Relayer::resolveRepaymentChain",
        message: `Preferred chains ${JSON.stringify(
          preferredChainIds
        )} are not profitable. Checking destination chain ${destinationChainId} profitability.`,
        deposit: { originChain, depositId: depositId.toString(), destinationChain, txnRef },
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
          message: `🦦 Taking repayment for filling deposit ${depositId.toString()} on preferred chains ${JSON.stringify(
            preferredChainIds
          )} is unprofitable but taking repayment on destination chain ${destinationChainId} is profitable. Electing to take repayment on top preferred chain ${preferredChain} as favor to depositor who assumed repayment on destination chain in their quote. Delta in net relayer fee: ${formatFeePct(
            deltaRelayerFee
          )}%`,
          deposit: {
            originChain,
            destinationChain,
            token: hubPoolToken,
            txnRef: blockExplorerLink(txnRef, originChainId),
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
          message: `Taking repayment for deposit ${depositId.toString()} with preferred chains ${JSON.stringify(
            preferredChainIds
          )} on destination chain ${destinationChainId} would also not be profitable.`,
          deposit: {
            originChain,
            destinationChain,
            txnRef,
            token: hubPoolToken,
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
        const { symbol, formatter } = this.formatAmount(chainId, toAddressType(token, chainId));
        let crossChainLog = "";
        if (this.clients.inventoryClient.isInventoryManagementEnabled() && chainId !== hubChainId) {
          // Shortfalls are mapped to deposit output tokens so look up output token in token symbol map.
          const l1Token = this.clients.inventoryClient.getL1TokenAddress(toAddressType(token, chainId), chainId);
          const outstandingCrossChainTransferAmount =
            this.clients.inventoryClient.crossChainTransferClient.getOutstandingCrossChainTransferAmount(
              this.relayerEvmAddress,
              chainId,
              l1Token,
              toAddressType(token, chainId)
            );
          crossChainLog = outstandingCrossChainTransferAmount.gt(0)
            ? " There is " +
              formatter(
                this.clients.inventoryClient.crossChainTransferClient
                  .getOutstandingCrossChainTransferAmount(
                    this.relayerEvmAddress,
                    chainId,
                    l1Token,
                    toAddressType(token, chainId)
                  )
                  // TODO: Add in additional l2Token param here once we can specify it
                  .toString()
              ) +
              ` inbound L1->L2 ${symbol} transfers. `
            : "";
        }
        mrkdwn +=
          ` - ${symbol} cumulative shortfall of ` +
          `${formatter(shortfall.toString())} ` +
          `(have ${formatter(balance.toString())} but need ` +
          `${formatter(needed.toString())}).${crossChainLog}` +
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
    tokenAddress: Address
  ): { symbol: string; decimals: number; formatter: (amount: string) => string } {
    const { symbol, decimals } = this.clients.hubPoolClient.getTokenInfoForAddress(tokenAddress, chainId);
    return { symbol, decimals, formatter: createFormatFunction(2, 4, false, decimals) };
  }

  // TODO: This should really be renamed to "handleUnfillableDeposit" since it not only logs about unprofitable relayer
  // fees but also about fills with messages that fail to simulate and deposits from lite chains that are
  // over-allocated.
  private handleUnprofitableFill() {
    const { profitClient } = this.clients;
    const unprofitableDeposits = profitClient.getUnprofitableFills();

    let mrkdwn = "";
    Object.keys(unprofitableDeposits).forEach((chainId) => {
      let depositMrkdwn = "";
      unprofitableDeposits[Number(chainId)].forEach((unprofitableFill) => {
        const { deposit, lpFeePct, relayerFeePct, gasCost } = unprofitableFill;

        // Skip notifying if the unprofitable fill happened too long ago to avoid spamming.
        if (deposit.quoteTimestamp + UNPROFITABLE_DEPOSIT_NOTICE_PERIOD < getCurrentTime()) {
          return;
        }

        const { originChainId, destinationChainId, inputToken, outputToken, inputAmount, outputAmount } = deposit;
        const depositblockExplorerLink = blockExplorerLink(deposit.txnRef, originChainId);
        const { symbol: inputSymbol, formatter: inputFormatter } = this.formatAmount(originChainId, inputToken);
        const formattedInputAmount = inputFormatter(inputAmount.toString());
        const { symbol: outputSymbol, formatter: outputFormatter } = this.formatAmount(destinationChainId, outputToken);
        const formattedOutputAmount = outputFormatter(outputAmount.toString());

        const { symbol: gasTokenSymbol, decimals: gasTokenDecimals } = profitClient.resolveGasToken(destinationChainId);
        const formattedGasCost = createFormatFunction(2, 10, false, gasTokenDecimals)(gasCost.toString());
        const formattedRelayerFeePct = formatFeePct(relayerFeePct);
        const formattedLpFeePct = formatFeePct(lpFeePct);

        // @dev If the deposit forces origin chain repayment and the LP fee percentage is infinity,
        // then we can assume that the originChain, the only possible repayment chain,
        // was not selected for repayment. So the "unprofitable" log should be modified to indicate
        // this  edge case.
        const fromOverallocatedLiteChain =
          depositForcesOriginChainRepayment(deposit, this.clients.hubPoolClient) && lpFeePct.eq(bnUint256Max);
        const depositFailedToSimulateWithMessage = !isMessageEmpty(deposit.message) && gasCost.eq(bnUint256Max);
        depositMrkdwn +=
          `- DepositId ${deposit.depositId.toString()} (tx: ${depositblockExplorerLink})` +
          ` of input amount ${formattedInputAmount} ${inputSymbol}` +
          ` and output amount ${formattedOutputAmount} ${outputSymbol}` +
          ` from ${getNetworkName(originChainId)} to ${getNetworkName(destinationChainId)}` +
          `${
            fromOverallocatedLiteChain
              ? " is from an over-allocated origin chain and it forces origin chain repayment"
              : ""
          }` +
          `${
            depositFailedToSimulateWithMessage
              ? ` failed to simulate with message of size ${ethersUtils.hexDataLength(deposit.message)} bytes`
              : ""
          }` +
          `${` with relayerFeePct ${formattedRelayerFeePct}% lpFeePct ${
            lpFeePct.eq(bnUint256Max) ? "∞" : formattedLpFeePct
          }% and gas cost ${gasCost.eq(bnUint256Max) ? "∞" : formattedGasCost} ${gasTokenSymbol}\n`}`;
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
        notificationPath: "across-unprofitable-fills",
      });
    }
  }

  private constructRelayFilledMrkdwn(
    deposit: Deposit,
    repaymentChainId: number,
    realizedLpFeePct: BigNumber,
    gasPrice: BigNumber
  ): string {
    let mrkdwn =
      this.constructBaseFillMarkdown(deposit, realizedLpFeePct, gasPrice) +
      ` Relayer repayment: ${getNetworkName(repaymentChainId)}.`;

    if (isDepositSpedUp(deposit)) {
      const { symbol, decimals } = this.clients.hubPoolClient.getTokenInfoForAddress(
        deposit.outputToken,
        deposit.destinationChainId
      );
      const updatedOutputAmount = createFormatFunction(2, 4, false, decimals)(deposit.updatedOutputAmount.toString());
      mrkdwn += ` Reduced output amount: ${updatedOutputAmount} ${symbol}.`;
    }

    return mrkdwn;
  }

  private constructBaseFillMarkdown(deposit: Deposit, _realizedLpFeePct: BigNumber, _gasPriceGwei: BigNumber): string {
    const { symbol, decimals } = this.clients.hubPoolClient.getTokenInfoForAddress(
      deposit.inputToken,
      deposit.originChainId
    );
    const srcChain = getNetworkName(deposit.originChainId);
    const dstChain = getNetworkName(deposit.destinationChainId);
    const depositor = blockExplorerLink(deposit.depositor.toNative(), deposit.originChainId);
    const inputAmount = createFormatFunction(2, 4, false, decimals)(deposit.inputAmount.toString());

    const { symbol: outputTokenSymbol, decimals: outputTokenDecimals } =
      this.clients.hubPoolClient.getTokenInfoForAddress(deposit.outputToken, deposit.destinationChainId);

    let msg = `Relayed depositId ${deposit.depositId.toString()} from ${srcChain} to ${dstChain} of ${inputAmount} ${symbol}`;
    const realizedLpFeePct = formatFeePct(_realizedLpFeePct);
    const adjustedInputAmount = sdkUtils.ConvertDecimals(decimals, outputTokenDecimals)(deposit.inputAmount);
    const _totalFeePct = adjustedInputAmount
      .sub(deposit.outputAmount)
      .mul(fixedPointAdjustment)
      .div(adjustedInputAmount);
    const totalFeePct = formatFeePct(_totalFeePct);

    const _outputAmount = createFormatFunction(2, 4, false, outputTokenDecimals)(deposit.outputAmount.toString());
    msg +=
      ` and output ${_outputAmount} ${outputTokenSymbol}, with depositor ${depositor}.` +
      ` Realized LP fee: ${realizedLpFeePct}%, total fee: ${totalFeePct}%. Gas price used in profit calc: ${formatGwei(
        _gasPriceGwei.toString()
      )} Gwei.`;

    return msg;
  }

  private getMulticaller(chainId: number): MultiCallerClient {
    return this.config.tryMulticallChains.includes(chainId)
      ? this.clients.tryMulticallClient
      : this.clients.multiCallerClient;
  }
}

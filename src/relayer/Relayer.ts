import assert from "assert";
import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import { utils as ethersUtils } from "ethers";
import { Deposit, DepositWithBlock, L1Token, V2Deposit, V3Deposit } from "../interfaces";
import {
  BigNumber,
  bnZero,
  bnOne,
  RelayerUnfilledDeposit,
  blockExplorerLink,
  buildFillRelayProps,
  buildFillRelayWithUpdatedFeeProps,
  createFormatFunction,
  formatFeePct,
  getCurrentTime,
  getNetworkName,
  getUnfilledDeposits,
  isDefined,
  toBNWei,
  winston,
} from "../utils";
import { RelayerClients } from "./RelayerClientHelper";
import { RelayerConfig } from "./RelayerConfig";

const { getAddress } = ethersUtils;
const { isDepositSpedUp, isMessageEmpty, resolveDepositMessage } = sdkUtils;
const UNPROFITABLE_DEPOSIT_NOTICE_PERIOD = 60 * 60; // 1 hour
const zeroFillAmount = bnOne;

export class Relayer {
  public readonly relayerAddress: string;

  // Track by originChainId since depositId is issued on the origin chain.
  // Key is in the form of "chainId-depositId".
  private fullyFilledDeposits: { [key: string]: boolean } = {};

  constructor(
    relayerAddress: string,
    readonly logger: winston.Logger,
    readonly clients: RelayerClients,
    readonly config: RelayerConfig
  ) {
    this.relayerAddress = getAddress(relayerAddress);
  }

  /**
   * @description Retrieve the complete array of unfilled deposits and filter out deposits we can't or choose
   * not to support.
   * @returns An array of filtered RelayerUnfilledDeposit objects.
   */
  private async _getUnfilledDeposits(): Promise<RelayerUnfilledDeposit[]> {
    const { configStoreClient, hubPoolClient, spokePoolClients, acrossApiClient } = this.clients;
    const { relayerTokens, ignoredAddresses, acceptInvalidFills } = this.config;

    const unfilledDeposits = await getUnfilledDeposits(spokePoolClients, hubPoolClient, this.config.maxRelayerLookBack);

    const maxVersion = configStoreClient.configStoreVersion;
    return unfilledDeposits.filter(({ deposit, version, invalidFills, unfilledAmount }) => {
      const { quoteTimestamp, depositId, depositor, recipient, originChainId, destinationChainId } = deposit;
      const destinationChain = getNetworkName(destinationChainId);

      // If we don't have the latest code to support this deposit, skip it.
      if (version > maxVersion) {
        this.logger.warn({
          at: "Relayer::getUnfilledDeposits",
          message: "Skipping deposit that is not supported by this relayer version.",
          latestVersionSupported: maxVersion,
          latestInConfigStore: configStoreClient.getConfigStoreVersionForTimestamp(),
          deposit,
        });
        return false;
      }

      if (!this.routeEnabled(originChainId, destinationChainId)) {
        this.logger.debug({
          at: "Relayer::getUnfilledDeposits",
          message: "Skipping deposit from or to disabled chains.",
          deposit,
          enabledOriginChains: this.config.relayerOriginChains,
          enabledDestinationChains: this.config.relayerDestinationChains,
        });
        return false;
      }

      // Skip deposits with quoteTimestamp in the future (impossible to know HubPool utilization => LP fee cannot be computed).
      if (quoteTimestamp > hubPoolClient.currentTime) {
        return false;
      }

      if (ignoredAddresses?.includes(getAddress(depositor)) || ignoredAddresses?.includes(getAddress(recipient))) {
        this.logger.debug({
          at: "Relayer::getUnfilledDeposits",
          message: "Ignoring deposit",
          depositor,
          recipient,
        });
        return false;
      }

      // Filters specific to v3.
      if (sdkUtils.isV3Deposit(deposit)) {
        // Technically it's the destination SpokePool timestamp that matters, but host timestamp should be good enough.
        const currentTime = getCurrentTime();
        if (deposit.fillDeadline <= currentTime) {
          return false;
        }

        if (deposit.exclusivityDeadline > currentTime && getAddress(deposit.exclusiveRelayer) !== this.relayerAddress) {
          return false;
        }
      }

      // Skip deposit with message if sending fills with messages is not supported.
      if (!this.config.sendingMessageRelaysEnabled && !isMessageEmpty(resolveDepositMessage(deposit))) {
        this.logger.warn({
          at: "Relayer::getUnfilledDeposits",
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
          at: "Relayer::getUnfilledDeposits",
          message: "👨‍👧‍👦 Skipping deposit with invalid fills from the same relayer",
          deposit,
          invalidFills,
          destinationChain,
        });
        return false;
      }

      // Resolve L1 token and perform additional checks
      // @todo: This is only relevant if inputToken and outputToken are equivalent.
      const inputToken = sdkUtils.getDepositInputToken(deposit);
      const l1Token = hubPoolClient.getL1TokenInfoForL2Token(inputToken, originChainId);

      // Skip any L1 tokens that are not specified in the config.
      // If relayerTokens is an empty list, we'll assume that all tokens are supported.
      if (relayerTokens.length > 0 && !relayerTokens.includes(l1Token.address)) {
        this.logger.debug({
          at: "Relayer::getUnfilledDeposits",
          message: "Skipping deposit for unwhitelisted token",
          deposit,
          l1Token,
        });
        return false;
      }

      // Filter out deposits that require in-protocol swaps.
      const outputToken = sdkUtils.getDepositOutputToken(deposit);
      if (!hubPoolClient.areTokensEquivalent(inputToken, originChainId, outputToken, destinationChainId)) {
        this.logger.debug({
          at: "Relayer::getUnfilledDeposits",
          message: "Skipping deposit including in-protocol token swap.",
          deposit,
          l1Token,
        });
        return false;
      }

      // We query the relayer API to get the deposit limits for different token and destination combinations.
      // The relayer should *not* be filling deposits that the HubPool doesn't have liquidity for otherwise the relayer's
      // refund will be stuck for potentially 7 days. Note: Filter for supported tokens first, since the relayer only
      // queries for limits on supported tokens.
      if (acrossApiClient.updatedLimits && unfilledAmount.gt(acrossApiClient.getLimit(l1Token.address))) {
        this.logger.warn({
          at: "Relayer::getUnfilledDeposits",
          message: "😱 Skipping deposit with greater unfilled amount than API suggested limit",
          limit: acrossApiClient.getLimit(l1Token.address),
          l1Token: l1Token.address,
          depositId,
          inputAmount: sdkUtils.getDepositInputAmount(deposit),
          unfilledAmount: unfilledAmount.toString(),
          originChainId,
          transactionHash: deposit.transactionHash,
        });
        return false;
      }

      // The deposit passed all checks, so we can include it in the list of unfilled deposits.
      return true;
    });
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

  async checkForUnfilledDepositsAndFill(sendSlowRelays = true): Promise<void> {
    // Fetch all unfilled deposits, order by total earnable fee.
    const { config } = this;
    const { hubPoolClient, profitClient, spokePoolClients, tokenClient, inventoryClient, multiCallerClient } =
      this.clients;

    // Flush any pre-existing enqueued transactions that might not have been executed.
    multiCallerClient.clearTransactionQueue();

    // Fetch unfilled deposits and filter out deposits upfront before we compute the minimum deposit confirmation
    // per chain, which is based on the deposit volume we could fill.
    const unfilledDeposits = await this._getUnfilledDeposits();

    // Sum the total unfilled deposit amount per origin chain and set a MDC for that chain.
    const unfilledDepositAmountsPerChain: { [chainId: number]: BigNumber } = unfilledDeposits.reduce((agg, curr) => {
      const unfilledAmountUsd = profitClient.getFillAmountInUsd(curr.deposit, curr.unfilledAmount);
      if (!agg[curr.deposit.originChainId]) {
        agg[curr.deposit.originChainId] = bnZero;
      }
      agg[curr.deposit.originChainId] = agg[curr.deposit.originChainId].add(unfilledAmountUsd);
      return agg;
    }, {});

    // Sort thresholds in ascending order.
    const minimumDepositConfirmationThresholds = Object.keys(config.minDepositConfirmations)
      .filter((x) => x !== "default")
      .sort((x, y) => Number(x) - Number(y));

    // Set the MDC for each origin chain equal to lowest threshold greater than the unfilled USD deposit amount.
    // If we can't find a threshold greater than the USD amount, then use the default.
    const mdcPerChain = Object.fromEntries(
      Object.entries(unfilledDepositAmountsPerChain).map(([chainId, unfilledAmount]) => {
        const usdThreshold = minimumDepositConfirmationThresholds.find((_usdThreshold) => {
          return toBNWei(_usdThreshold).gte(unfilledAmount);
        });
        // If no thresholds are greater than unfilled amount, then use fallback which should have largest MDCs.
        return [chainId, config.minDepositConfirmations[usdThreshold ?? "default"][chainId]];
      })
    );
    this.logger.debug({
      at: "Relayer::checkForUnfilledDepositsAndFill",
      message: "Setting minimum deposit confirmation based on origin chain aggregate deposit amount",
      unfilledDepositAmountsPerChain,
      mdcPerChain,
      minDepositConfirmations: config.minDepositConfirmations,
    });

    // Filter out deposits whose block time does not meet the minimum number of confirmations for the origin chain.
    const confirmedUnfilledDeposits = unfilledDeposits.filter(
      ({ deposit: { originChainId, blockNumber } }) =>
        blockNumber <= spokePoolClients[originChainId].latestBlockSearched - mdcPerChain[originChainId]
    );
    this.logger.debug({
      at: "Relayer::checkForUnfilledDepositsAndFill",
      message: `${confirmedUnfilledDeposits.length} unfilled deposits found`,
    });

    // Iterate over all unfilled deposits. For each unfilled deposit: a) check that the token balance client has enough
    // balance to fill the unfilled amount. b) the fill is profitable. If both hold true then fill the unfilled amount.
    // If not enough ballance add the shortfall to the shortfall tracker to produce an appropriate log. If the deposit
    // is has no other fills then send a 0 sized fill to initiate a slow relay. If unprofitable then add the
    // unprofitable tx to the unprofitable tx tracker to produce an appropriate log.
    for (const { deposit, unfilledAmount, fillCount } of confirmedUnfilledDeposits) {
      const { slowDepositors } = config;

      const { depositor, recipient, destinationChainId, originChainId } = deposit;
      const inputToken = sdkUtils.getDepositInputToken(deposit);

      // If depositor is on the slow deposit list, then send a zero fill to initiate a slow relay and return early.
      if (slowDepositors?.includes(depositor)) {
        if (sendSlowRelays && fillCount === 0 && tokenClient.hasBalanceForZeroFill(deposit)) {
          this.logger.debug({
            at: "Relayer",
            message: "Initiating slow fill for grey listed depositor",
            depositor,
          });
          this.requestSlowFill(deposit, fillCount);
        }
        // Regardless of whether we should send a slow fill or not for this depositor, exit early at this point
        // so we don't fast fill an already slow filled deposit from the slow fill-only list.
        continue;
      }

      const l1Token = hubPoolClient.getL1TokenInfoForL2Token(inputToken, originChainId);
      const selfRelay = [depositor, recipient].every((address) => address === this.relayerAddress);
      if (tokenClient.hasBalanceForFill(deposit, unfilledAmount) && !selfRelay) {
        const { repaymentChainId, gasLimit: gasCost } = await this.resolveRepaymentChain(
          deposit,
          unfilledAmount,
          l1Token
        );
        if (isDefined(repaymentChainId)) {
          const gasLimit = isMessageEmpty(resolveDepositMessage(deposit)) ? undefined : gasCost;
          this.fillRelay(deposit, repaymentChainId, gasLimit);
        } else {
          profitClient.captureUnprofitableFill(deposit, unfilledAmount, gasCost);
        }
      } else if (selfRelay) {
        // A relayer can fill its own deposit without an ERC20 transfer. Only bypass profitability requirements if the
        // relayer is both the depositor and the recipient, because a deposit on a cheap SpokePool chain could cause
        // expensive fills on (for example) mainnet.
        this.fillRelay(deposit, destinationChainId);
      } else {
        // TokenClient.getBalance returns that we don't have enough balance to submit the fast fill.
        // At this point, capture the shortfall so that the inventory manager can rebalance the token inventory.
        tokenClient.captureTokenShortfallForFill(deposit, unfilledAmount);

        // Before deciding whether to zero fill, first determine if the inventory manager will subsequently send
        // funds to the destination chain to cover the shortfall. If it will, then check if the new balance
        // will be enough for the relayer to submit a fast fill. If so, then don't zero fill so that the
        // relayer can send this full fill and elect where to take repayment. This is assuming the contract
        // enforces that partial fills must take  repayment on the destination which can lead to over-allocations
        // on the destination chain if we always sent zero/partial fills here.
        let willFastFillAfterRebalance = false;

        // @dev: `getBalanceOnChainForL1Token` accounts for outstanding cross chain transfers via the
        // CrossChainTransferClient.
        const currentDestinationChainBalance = inventoryClient.getBalanceOnChainForL1Token(
          destinationChainId,
          l1Token.address
        );
        const crossChainTxns = inventoryClient.crossChainTransferClient.getOutstandingCrossChainTransferTxs(
          this.relayerAddress,
          destinationChainId,
          l1Token.address
        );
        let newChainBalance = currentDestinationChainBalance;
        if (newChainBalance.gte(unfilledAmount)) {
          this.logger.debug({
            at: "Relayer",
            message:
              "Skipping zero fills for this token because there are outstanding cross chain transfers that can be used to fast fill this deposit",
            currentDestinationChainBalanceIncludingOutstandingTransfers: currentDestinationChainBalance,
            crossChainTxns,
          });
          continue;
        }

        // Check for upcoming rebalances.
        const rebalances = inventoryClient.getPossibleRebalances();
        const rebalanceForFilledToken = rebalances.find(
          ({ l1Token: l1TokenForFill, chainId, amount, balance }) =>
            l1TokenForFill === l1Token.address && chainId === destinationChainId && amount.lte(balance) // It's important we count only rebalances that are executable based on current L1 balance.
        );
        if (rebalanceForFilledToken !== undefined) {
          newChainBalance = newChainBalance.add(rebalanceForFilledToken.amount);
          willFastFillAfterRebalance = newChainBalance.gte(unfilledAmount);
          this.logger.debug({
            at: "Relayer",
            message:
              "Inventory manager will rebalance to this chain after capturing token shortfall. Will skip zero fill if this deposit will be fillable after rebalance.",
            currentDestinationChainBalanceIncludingOutstandingTransfers: currentDestinationChainBalance,
            crossChainTxns,
            newChainBalance,
            rebalanceForFilledToken,
            rebalances,
            willFastFillAfterRebalance,
          });
          if (willFastFillAfterRebalance) {
            continue;
          }
        } else {
          this.logger.debug({
            at: "Relayer",
            message: "No rebalances for filled token, proceeding to evaluate slow fill request",
            depositL1Token: l1Token.address,
            currentDestinationChainBalanceIncludingOutstandingTransfers: currentDestinationChainBalance,
            crossChainTxns,
            rebalances,
          });
        }

        // If we don't have enough balance to fill the deposit, consider requesting a slow fill.
        if (sendSlowRelays) {
          this.requestSlowFill(deposit, fillCount);
        }
      }
    }
    // If during the execution run we had shortfalls or unprofitable fills then handel it by producing associated logs.
    if (tokenClient.anyCapturedShortFallFills()) {
      this.handleTokenShortfall();
    }
    if (profitClient.anyCapturedUnprofitableFills()) {
      this.handleUnprofitableFill();
    }
  }

  requestSlowFill(deposit: Deposit, fillCount: number): void {
    // Verify that the _original_ message was empty, since that's what would be used in a slow fill. If a non-empty
    // message was nullified by an update, it can be full-filled but preferably not automatically zero-filled.
    if (!isMessageEmpty(deposit.message)) {
      this.logger.warn({
        at: "Relayer::zeroFillDeposit",
        message: "Suppressing slow fill request for deposit with message.",
        deposit,
      });
      return;
    }

    const { hubPoolClient, spokePoolClients, tokenClient, multiCallerClient } = this.clients;
    if (sdkUtils.isV2Deposit(deposit)) {
      if (fillCount === 0 && tokenClient.hasBalanceForZeroFill(deposit)) {
        this.zeroFillDeposit(deposit);
      }
      return;
    }

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

    this.logger.debug({ at: "Relayer", message: "Enqueuing slow fill request.", deposit });
    multiCallerClient.enqueueTransaction({
      chainId: destinationChainId,
      contract: spokePoolClient.spokePool,
      method: "requestV3SlowFill",
      args: [deposit],
      message: "Requested slow fill for deposit.",
      mrkdwn: formatSlowFillRequestMarkdown(),
    });
  }

  fillRelay(deposit: Deposit, repaymentChainId: number, gasLimit?: BigNumber): void {
    // Skip deposits that this relayer has already filled completely before to prevent double filling (which is a waste
    // of gas as the second fill would fail).
    // TODO: Handle the edge case scenario where the first fill failed due to transient errors and needs to be retried.
    const fillKey = `${deposit.originChainId}-${deposit.depositId}`;
    if (this.fullyFilledDeposits[fillKey]) {
      this.logger.debug({
        at: "Relayer",
        message: "Skipping deposit already filled by this relayer.",
        originChainId: deposit.originChainId,
        depositId: deposit.depositId,
      });
      return;
    }

    sdkUtils.isV2Deposit(deposit)
      ? this.fillV2Relay(deposit, sdkUtils.getDepositOutputAmount(deposit), repaymentChainId, gasLimit)
      : this.fillV3Relay(deposit, repaymentChainId, gasLimit);

    // All fills routed through `fillRelay()` will complete the relay.
    this.fullyFilledDeposits[fillKey] = true;
  }

  fillV3Relay(deposit: V3Deposit, repaymentChainId: number, gasLimit?: BigNumber): void {
    assert(sdkUtils.isV3Deposit(deposit));
    const { spokePoolClients, multiCallerClient } = this.clients;
    this.logger.debug({ at: "Relayer", message: "Filling v3 deposit.", deposit, repaymentChainId });

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
    const mrkdwn = this.constructRelayFilledMrkdwn(deposit, repaymentChainId, deposit.outputAmount);
    const contract = spokePoolClients[deposit.destinationChainId].spokePool;
    const chainId = deposit.destinationChainId;
    multiCallerClient.enqueueTransaction({ contract, chainId, method, args, gasLimit, message, mrkdwn });
  }

  fillV2Relay(deposit: V2Deposit, fillAmount: BigNumber, repaymentChainId: number, gasLimit?: BigNumber): void {
    const zeroFill = fillAmount.eq(zeroFillAmount);
    this.logger.debug({
      at: "Relayer",
      message: zeroFill ? "Zero filling" : "Filling deposit",
      deposit,
      repaymentChainId,
    });

    // If deposit has been sped up, call fillRelayWithUpdatedFee instead. This guarantees that the relayer wouldn't
    // accidentally double fill due to the deposit hash being different - SpokePool contract will check that the
    // original hash with the old fee hasn't been filled.
    const [method, argBuilder, messageModifier] = isDepositSpedUp(deposit)
      ? ["fillRelayWithUpdatedDeposit", buildFillRelayWithUpdatedFeeProps, "with modified parameters "]
      : ["fillRelay", buildFillRelayProps, ""];

    const outputAmount = sdkUtils.getDepositOutputAmount(deposit);
    // prettier-ignore
    const message = fillAmount.eq(outputAmount)
      ? `Filled deposit ${messageModifier}🚀`
      : zeroFill
        ? `Zero filled deposit ${messageModifier}🐌`
        : `Partially filled deposit ${messageModifier}📫`;

    this.clients.multiCallerClient.enqueueTransaction({
      contract: this.clients.spokePoolClients[deposit.destinationChainId].spokePool,
      chainId: deposit.destinationChainId,
      method,
      args: argBuilder(deposit, repaymentChainId, fillAmount),
      gasLimit,
      message,
      mrkdwn: this.constructRelayFilledMrkdwn(deposit, repaymentChainId, fillAmount),
    });

    // Decrement tokens in token client used in the fill. This ensures that we dont try and fill more than we have.
    const outputToken = sdkUtils.getDepositOutputToken(deposit);
    this.clients.tokenClient.decrementLocalBalance(deposit.destinationChainId, outputToken, fillAmount);
  }

  /**
   * @description Initiate a zero-fill for a deposit.
   * @param deposit Deposit object to zero-fill.
   */
  zeroFillDeposit(deposit: V2Deposit): void {
    this.fillV2Relay(deposit, zeroFillAmount, deposit.destinationChainId);
  }

  protected async resolveRepaymentChain(
    deposit: DepositWithBlock,
    fillAmount: BigNumber,
    hubPoolToken: L1Token
  ): Promise<{
    gasLimit: BigNumber;
    repaymentChainId?: number;
    realizedLpFeePct: BigNumber;
    relayerFeePct: BigNumber;
  }> {
    const { hubPoolClient, inventoryClient, profitClient } = this.clients;
    const { depositId, originChainId, destinationChainId, transactionHash: depositHash } = deposit;
    const outputAmount = sdkUtils.getDepositOutputAmount(deposit);

    if (!fillAmount.eq(outputAmount)) {
      const originChain = getNetworkName(originChainId);
      const destinationChain = getNetworkName(destinationChainId);
      this.logger.debug({
        at: "Relayer",
        message: `Skipping repayment chain determination for partial fill on ${destinationChain}`,
        deposit: { originChain, depositId, destinationChain, depositHash },
      });
    }

    const preferredChainId = fillAmount.eq(outputAmount)
      ? await inventoryClient.determineRefundChainId(deposit, hubPoolToken.address)
      : destinationChainId;

    const { realizedLpFeePct } = sdkUtils.isV3Deposit(deposit)
      ? await hubPoolClient.computeRealizedLpFeePct(deposit)
      : deposit;

    const {
      profitable,
      nativeGasCost: gasLimit,
      grossRelayerFeePct: relayerFeePct,
    } = await profitClient.isFillProfitable(deposit, fillAmount, realizedLpFeePct, hubPoolToken);

    return {
      gasLimit,
      repaymentChainId: profitable ? preferredChainId : undefined,
      realizedLpFeePct,
      relayerFeePct,
    };
  }

  private handleTokenShortfall() {
    const tokenShortfall = this.clients.tokenClient.getTokenShortfall();

    let mrkdwn = "";
    Object.entries(tokenShortfall).forEach(([_chainId, shortfallForChain]) => {
      const chainId = Number(_chainId);
      mrkdwn += `*Shortfall on ${getNetworkName(chainId)}:*\n`;
      Object.entries(shortfallForChain).forEach(([token, { shortfall, balance, needed, deposits }]) => {
        const { symbol, decimals } = this.clients.hubPoolClient.getTokenInfo(chainId, token);
        const formatter = createFormatFunction(2, 4, false, decimals);
        let crossChainLog = "";
        if (this.clients.inventoryClient.isInventoryManagementEnabled() && chainId !== 1) {
          const l1Token = this.clients.hubPoolClient.getL1TokenInfoForL2Token(token, chainId);
          crossChainLog =
            "There is " +
            formatter(
              this.clients.inventoryClient.crossChainTransferClient
                .getOutstandingCrossChainTransferAmount(this.relayerAddress, chainId, l1Token.address)
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

    this.logger.warn({ at: "Relayer", message: "Insufficient balance to fill all deposits 💸!", mrkdwn });
  }

  private handleUnprofitableFill() {
    const unprofitableDeposits = this.clients.profitClient.getUnprofitableFills();

    let mrkdwn = "";
    Object.keys(unprofitableDeposits).forEach((chainId) => {
      let depositMrkdwn = "";
      Object.keys(unprofitableDeposits[chainId]).forEach((depositId) => {
        const { deposit, fillAmount, gasCost: _gasCost } = unprofitableDeposits[chainId][depositId];
        // Skip notifying if the unprofitable fill happened too long ago to avoid spamming.
        if (deposit.quoteTimestamp + UNPROFITABLE_DEPOSIT_NOTICE_PERIOD < getCurrentTime()) {
          return;
        }
        const gasCost = _gasCost.toString();

        const { symbol, decimals } = this.clients.hubPoolClient.getTokenInfoForDeposit(deposit);
        const formatFunction = createFormatFunction(2, 4, false, decimals);
        const gasFormatFunction = createFormatFunction(2, 10, false, 18);
        const depositblockExplorerLink = blockExplorerLink(deposit.transactionHash, deposit.originChainId);

        const inputAmount = formatFunction(sdkUtils.getDepositInputAmount(deposit).toString());
        const relayerFeePct = formatFeePct(sdkUtils.isV2Deposit(deposit) ? deposit.relayerFeePct : bnZero); // @todo
        depositMrkdwn +=
          `- DepositId ${deposit.depositId} (tx: ${depositblockExplorerLink}) of amount ${inputAmount} ${symbol}` +
          ` with a relayerFeePct ${relayerFeePct}% and gas cost ${gasFormatFunction(gasCost)}` +
          ` from ${getNetworkName(deposit.originChainId)} to ${getNetworkName(deposit.destinationChainId)}` +
          ` and an unfilled amount of ${formatFunction(fillAmount.toString())} ${symbol} is unprofitable!\n`;
      });

      if (depositMrkdwn) {
        mrkdwn += `*Unprofitable deposits on ${getNetworkName(chainId)}:*\n` + depositMrkdwn;
      }
    });

    if (mrkdwn) {
      this.logger.warn({ at: "Relayer", message: "Not relaying unprofitable deposits 🙅‍♂️!", mrkdwn });
    }
  }

  private constructRelayFilledMrkdwn(deposit: Deposit, repaymentChainId: number, fillAmount: BigNumber): string {
    let mrkdwn =
      this.constructBaseFillMarkdown(deposit, fillAmount) + ` Relayer repayment: ${getNetworkName(repaymentChainId)}.`;

    if (isDepositSpedUp(deposit)) {
      if (sdkUtils.isV2Deposit(deposit)) {
        mrkdwn += ` Modified relayer fee: ${formatFeePct(deposit.newRelayerFeePct)}%.`;
      } else {
        const { symbol, decimals } = this.clients.hubPoolClient.getTokenInfo(
          deposit.destinationChainId,
          deposit.outputToken
        );
        const formatter = createFormatFunction(2, 4, false, decimals);
        // @todo Would be nice to compute the updated relayerFeePct as well.
        mrkdwn += ` Reduced output amount: ${formatter(deposit.updatedOutputAmount.toString())} ${symbol}.`;
      }
    }

    return mrkdwn;
  }

  private constructBaseFillMarkdown(deposit: Deposit, fillAmount: BigNumber): string {
    const { symbol, decimals } = this.clients.hubPoolClient.getTokenInfoForDeposit(deposit);
    const srcChain = getNetworkName(deposit.originChainId);
    const dstChain = getNetworkName(deposit.destinationChainId);
    const depositor = blockExplorerLink(deposit.depositor, deposit.originChainId);
    const inputAmount = sdkUtils.getDepositInputAmount(deposit);
    const _inputAmount = createFormatFunction(2, 4, false, decimals)(inputAmount.toString());

    let msg = `Relayed depositId ${deposit.depositId} from ${srcChain} to ${dstChain} of ${_inputAmount} ${symbol}`;
    if (sdkUtils.isV2Deposit(deposit)) {
      const _fillAmount = createFormatFunction(2, 4, false, decimals)(fillAmount.toString());
      const _relayerFeePct = formatFeePct(deposit.relayerFeePct);
      const realizedLpFeePct = formatFeePct(deposit.realizedLpFeePct);
      msg +=
        ` with depositor ${depositor}. Fill amount of ${_fillAmount} ${symbol}` +
        ` with relayerFee ${_relayerFeePct}% & realizedLpFee ${realizedLpFeePct}%.`;

      if (fillAmount.eq(zeroFillAmount)) {
        msg += " Has been zero filled due to a token shortfall! This will initiate a slow relay for this deposit.";
      }
    } else {
      const { symbol: outputTokenSymbol, decimals: outputTokenDecimals } =
        this.clients.hubPoolClient.getTokenInfoForDeposit(deposit);
      const outputAmount = deposit.outputAmount;
      const _outputAmount = createFormatFunction(2, 4, false, outputTokenDecimals)(outputAmount.toString());
      msg += ` and output ${_outputAmount} ${outputTokenSymbol}, with depositor ${depositor}.`;
    }

    return msg;
  }
}

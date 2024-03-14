import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import { utils as ethersUtils } from "ethers";
import { FillStatus, L1Token, V3Deposit, V3DepositWithBlock } from "../interfaces";
import {
  BigNumber,
  bnZero,
  RelayerUnfilledDeposit,
  blockExplorerLink,
  createFormatFunction,
  formatFeePct,
  getCurrentTime,
  getNetworkName,
  getUnfilledDeposits,
  isDefined,
  toBNWei,
  winston,
  fixedPointAdjustment,
  getAlchemySdk,
} from "../utils";
import { RelayerClients } from "./RelayerClientHelper";
import { RelayerConfig } from "./RelayerConfig";

const { getAddress } = ethersUtils;
const { isDepositSpedUp, isMessageEmpty, resolveDepositMessage } = sdkUtils;
const UNPROFITABLE_DEPOSIT_NOTICE_PERIOD = 60 * 60; // 1 hour

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

    // Flatten unfilledDeposits for now. @todo: Process deposits in parallel by destination chain.
    const unfilledDeposits = Object.values(
      await getUnfilledDeposits(spokePoolClients, hubPoolClient, this.config.maxRelayerLookBack)
    ).flat();

    const maxVersion = configStoreClient.configStoreVersion;
    return sdkUtils.filterAsync(unfilledDeposits, async ({ deposit, version, invalidFills }) => {
      const { depositId, depositor, recipient, originChainId, destinationChainId, inputToken, outputToken } = deposit;
      const destinationChain = getNetworkName(destinationChainId);
      const destinationSpokePoolClient = this.clients.spokePoolClients[destinationChainId];

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
      if (deposit.quoteTimestamp > hubPoolClient.currentTime) {
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

      // Skip any L1 tokens that are not specified in the config.
      // If relayerTokens is an empty list, we'll assume that all tokens are supported.
      const l1Token = hubPoolClient.getL1TokenInfoForL2Token(inputToken, originChainId);
      if (relayerTokens.length > 0 && !relayerTokens.includes(l1Token.address)) {
        this.logger.debug({
          at: "Relayer::getUnfilledDeposits",
          message: "Skipping deposit for unwhitelisted token",
          deposit,
          l1Token,
        });
        return false;
      }

      // It would be preferable to use host time since it's more reliably up-to-date, but this creates issues in test.
      const currentTime = destinationSpokePoolClient.getCurrentTime();
      if (deposit.fillDeadline <= currentTime) {
        return false;
      }

      if (deposit.exclusivityDeadline > currentTime && getAddress(deposit.exclusiveRelayer) !== this.relayerAddress) {
        return false;
      }

      if (!hubPoolClient.areTokensEquivalent(inputToken, originChainId, outputToken, destinationChainId)) {
        this.logger.warn({
          at: "Relayer::getUnfilledDeposits",
          message: "Skipping deposit including in-protocol token swap.",
          deposit,
        });
        return false;
      }

      const destSpokePool = destinationSpokePoolClient.spokePool;
      const fillStatus = await sdkUtils.relayFillStatus(destSpokePool, deposit, "latest", destinationChainId);
      if (fillStatus === FillStatus.Filled) {
        this.logger.debug({
          at: "Relayer::getUnfilledDeposits",
          message: "Skipping deposit that was already filled.",
          deposit,
        });
        return false;
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

      // We query the relayer API to get the deposit limits for different token and destination combinations.
      // The relayer should *not* be filling deposits that the HubPool doesn't have liquidity for otherwise the relayer's
      // refund will be stuck for potentially 7 days. Note: Filter for supported tokens first, since the relayer only
      // queries for limits on supported tokens.
      const { inputAmount } = deposit;
      if (acrossApiClient.updatedLimits && inputAmount.gt(acrossApiClient.getLimit(l1Token.address))) {
        this.logger.warn({
          at: "Relayer::getUnfilledDeposits",
          message: "😱 Skipping deposit with greater unfilled amount than API suggested limit",
          limit: acrossApiClient.getLimit(l1Token.address),
          l1Token: l1Token.address,
          depositId,
          inputToken,
          inputAmount,
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
    const unfilledDepositAmountsPerChain: { [chainId: number]: BigNumber } = unfilledDeposits.reduce(
      (agg, { deposit }) => {
        const unfilledAmountUsd = profitClient.getFillAmountInUsd(deposit, deposit.outputAmount);
        agg[deposit.originChainId] = (agg[deposit.originChainId] ?? bnZero).add(unfilledAmountUsd);
        return agg;
      },
      {}
    );

    // Sort thresholds in ascending order.
    const minimumDepositConfirmationThresholds = Object.keys(config.minDepositConfirmations)
      .filter((x) => x !== "default")
      .sort((x, y) => Number(x) - Number(y));

    // Set the MDC for each origin chain equal to lowest threshold greater than the unfilled USD deposit amount.
    // If we can't find a threshold greater than the USD amount, then use the default.
    const mdcPerChain = Object.fromEntries(
      Object.entries(unfilledDepositAmountsPerChain).map(([chainId, unfilledAmount]) => {
        const usdThreshold = minimumDepositConfirmationThresholds.find((_usdThreshold) => {
          return (
            toBNWei(_usdThreshold).gte(unfilledAmount) &&
            isDefined(config.minDepositConfirmations[_usdThreshold][chainId])
          );
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
    const confirmedUnfilledDeposits = unfilledDeposits
      .filter(
        ({ deposit: { originChainId, blockNumber } }) =>
          blockNumber <= spokePoolClients[originChainId].latestBlockSearched - mdcPerChain[originChainId]
      )
      .map(({ deposit }) => deposit);
    this.logger.debug({
      at: "Relayer::checkForUnfilledDepositsAndFill",
      message: `${confirmedUnfilledDeposits.length} unfilled deposits found`,
    });

    // Iterate over all unfilled deposits. For each unfilled deposit: a) check that the token balance client has enough
    // balance to fill the unfilled amount. b) the fill is profitable. If both hold true then fill the unfilled amount.
    // If not enough ballance add the shortfall to the shortfall tracker to produce an appropriate log. If the deposit
    // is has no other fills then send a 0 sized fill to initiate a slow relay. If unprofitable then add the
    // unprofitable tx to the unprofitable tx tracker to produce an appropriate log.
    const { slowDepositors } = config;
    for (const deposit of confirmedUnfilledDeposits) {
      const { depositor, recipient, destinationChainId, originChainId, inputToken, outputAmount } = deposit;

      // If depositor is on the slow deposit list, then send a zero fill to initiate a slow relay and return early.
      if (slowDepositors?.includes(depositor)) {
        if (sendSlowRelays) {
          this.logger.debug({
            at: "Relayer",
            message: "Initiating slow fill for grey listed depositor",
            depositor,
          });
          this.requestSlowFill(deposit);
        }
        // Regardless of whether we should send a slow fill or not for this depositor, exit early at this point
        // so we don't fast fill an already slow filled deposit from the slow fill-only list.
        continue;
      }

      const l1Token = hubPoolClient.getL1TokenInfoForL2Token(inputToken, originChainId);
      const selfRelay = [depositor, recipient].every((address) => address === this.relayerAddress);
      if (tokenClient.hasBalanceForFill(deposit, outputAmount) && !selfRelay) {
        const {
          repaymentChainId,
          realizedLpFeePct,
          relayerFeePct,
          gasLimit: _gasLimit,
          gasCost,
        } = await this.resolveRepaymentChain(deposit, l1Token);
        if (isDefined(repaymentChainId)) {
          const gasLimit = isMessageEmpty(resolveDepositMessage(deposit)) ? undefined : _gasLimit;
          this.fillRelay(deposit, repaymentChainId, realizedLpFeePct, gasLimit);
        } else {
          profitClient.captureUnprofitableFill(deposit, realizedLpFeePct, relayerFeePct, gasCost);
        }
      } else if (selfRelay) {
        const { realizedLpFeePct } = await hubPoolClient.computeRealizedLpFeePct({
          ...deposit,
          paymentChainId: destinationChainId,
        });

        // A relayer can fill its own deposit without an ERC20 transfer. Only bypass profitability requirements if the
        // relayer is both the depositor and the recipient, because a deposit on a cheap SpokePool chain could cause
        // expensive fills on (for example) mainnet.
        this.fillRelay(deposit, destinationChainId, realizedLpFeePct);
      } else {
        // TokenClient.getBalance returns that we don't have enough balance to submit the fast fill.
        // At this point, capture the shortfall so that the inventory manager can rebalance the token inventory.
        tokenClient.captureTokenShortfallForFill(deposit, outputAmount);

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
        if (newChainBalance.gte(outputAmount)) {
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
          willFastFillAfterRebalance = newChainBalance.gte(outputAmount);
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
          this.requestSlowFill(deposit);
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

  requestSlowFill(deposit: V3Deposit): void {
    // Verify that the _original_ message was empty, since that's what would be used in a slow fill. If a non-empty
    // message was nullified by an update, it can be full-filled but preferably not automatically zero-filled.
    if (!isMessageEmpty(deposit.message)) {
      this.logger.warn({
        at: "Relayer#requestSlowFill",
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

  fillRelay(deposit: V3Deposit, repaymentChainId: number, realizedLpFeePct: BigNumber, gasLimit?: BigNumber): void {
    const { originChainId, depositId, outputToken, outputAmount } = deposit;
    // Skip deposits that this relayer has already filled completely before to prevent double filling (which is a waste
    // of gas as the second fill would fail).
    // TODO: Handle the edge case scenario where the first fill failed due to transient errors and needs to be retried.
    const fillKey = `${originChainId}-${depositId}`;
    if (this.fullyFilledDeposits[fillKey]) {
      this.logger.debug({
        at: "Relayer",
        message: "Skipping deposit already filled by this relayer.",
        originChainId: deposit.originChainId,
        depositId: deposit.depositId,
      });
      return;
    }

    const { spokePoolClients, multiCallerClient } = this.clients;
    this.logger.debug({ at: "Relayer", message: "Filling v3 deposit.", deposit, repaymentChainId, realizedLpFeePct });

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

    // If the deposit has a message, add an additional layer of security by requesting a second simulation via the
    // Alchemy SDK. We've noticed that some of these deposits with messages where the recipient is a Proxy contract that
    // the ethers and Alchemy gas estimations can disagree. This is a temporary solution until we can figure out why
    // this discrepancy exists for these types of deposits.
    let alchemySimulate = !isMessageEmpty(resolveDepositMessage(deposit));
    if (alchemySimulate) {
      const alchemySdkExists = getAlchemySdk(chainId);
      if (!alchemySdkExists) {
        this.logger.warn({
          at: "Relayer#fillRelay",
          message: `Alchemy SDK cannot be constructed for chain ${chainId}`,
        });
        alchemySimulate = false;
      }
    }
    multiCallerClient.enqueueTransaction({
      contract,
      chainId,
      method,
      args,
      gasLimit,
      message,
      mrkdwn,
      alchemySimulate,
    });

    // Decrement tokens in token client used in the fill. This ensures that we dont try and fill more than we have.
    this.clients.tokenClient.decrementLocalBalance(deposit.destinationChainId, outputToken, outputAmount);

    // All fills routed through `fillRelay()` will complete the relay.
    this.fullyFilledDeposits[fillKey] = true;
  }

  protected async resolveRepaymentChain(
    deposit: V3DepositWithBlock,
    hubPoolToken: L1Token
  ): Promise<{
    gasLimit: BigNumber;
    repaymentChainId?: number;
    realizedLpFeePct: BigNumber;
    relayerFeePct: BigNumber;
    gasCost: BigNumber;
  }> {
    const { hubPoolClient, inventoryClient, profitClient } = this.clients;
    const { depositId, originChainId, destinationChainId, inputAmount, outputAmount, transactionHash } = deposit;
    const originChain = getNetworkName(originChainId);
    const destinationChain = getNetworkName(destinationChainId);

    const preferredChainId = await inventoryClient.determineRefundChainId(deposit, hubPoolToken.address);
    const { realizedLpFeePct } = await hubPoolClient.computeRealizedLpFeePct({
      ...deposit,
      paymentChainId: preferredChainId,
    });

    const {
      profitable,
      nativeGasCost: gasLimit,
      tokenGasCost: gasCost,
      grossRelayerFeePct: relayerFeePct, // gross relayer fee is equal to total fee minus the lp fee.
    } = await profitClient.isFillProfitable(deposit, realizedLpFeePct, hubPoolToken);
    // If preferred chain is different from the destination chain and the preferred chain
    // is not profitable, then check if the destination chain is profitable.
    // This assumes that the depositor is getting quotes from the /suggested-fees endpoint
    // in the frontend-v2 repo which assumes that repayment is the destination chain. If this is profitable, then
    // go ahead and use the preferred chain as repayment and log the lp fee delta. This is a temporary solution
    // so that depositors can continue to quote lp fees assuming repayment is on the destination chain until
    // we come up with a smarter profitability check.
    if (!profitable && preferredChainId !== destinationChainId) {
      this.logger.debug({
        at: "Relayer",
        message: `Preferred chain ${preferredChainId} is not profitable. Checking destination chain ${destinationChainId} profitability.`,
        deposit: { originChain, depositId, destinationChain, transactionHash },
      });
      const { realizedLpFeePct: destinationChainLpFeePct } = await hubPoolClient.computeRealizedLpFeePct({
        ...deposit,
        paymentChainId: destinationChainId,
      });

      const fallbackProfitability = await profitClient.isFillProfitable(
        deposit,
        destinationChainLpFeePct,
        hubPoolToken
      );
      if (fallbackProfitability.profitable) {
        // This is the delta in the gross relayer fee. If negative, then the destination chain would have had a higher
        // gross relayer fee, and therefore represents a virtual loss to the relayer. However, the relayer is
        // maintaining its inventory allocation by sticking to its preferred repayment chain.
        const deltaRelayerFee = relayerFeePct.sub(fallbackProfitability.grossRelayerFeePct);
        this.logger.info({
          at: "Relayer",
          message: `🦦 Taking repayment for filling deposit ${depositId} on preferred chain ${preferredChainId} is unprofitable but taking repayment on destination chain ${destinationChainId} is profitable. Electing to take repayment on preferred chain as favor to depositor who assumed repayment on destination chain in their quote. Delta in gross relayer fee: ${formatFeePct(
            deltaRelayerFee
          )}%`,
          deposit: {
            originChain,
            destinationChain,
            token: hubPoolToken.symbol,
            txnHash: blockExplorerLink(transactionHash, originChainId),
          },
          preferredChain: getNetworkName(preferredChainId),
          preferredChainLpFeePct: `${formatFeePct(realizedLpFeePct)}%`,
          destinationChainLpFeePct: `${formatFeePct(destinationChainLpFeePct)}%`,
          // The delta will cut into the gross relayer fee. If negative, then taking the repayment on destination chain
          // would have been more profitable to the relayer because the lp fee would have been lower.
          deltaLpFeePct: `${formatFeePct(destinationChainLpFeePct.sub(realizedLpFeePct))}%`,
          // relayer fee is the gross relayer fee using the destination chain lp fee: inputAmount - outputAmount - lpFee.
          preferredChainRelayerFeePct: `${formatFeePct(relayerFeePct)}%`,
          destinationChainRelayerFeePct: `${formatFeePct(fallbackProfitability.grossRelayerFeePct)}%`,
          deltaRelayerFee: `${formatFeePct(deltaRelayerFee)}%`,
        });

        // We've checked that the user set the output amount honestly and assumed that the payment would be on
        // destination chain, therefore we will fill them using the original preferred chain to maintain
        // inventory assumptions and also quote the original relayer fee pct.
        return {
          repaymentChainId: preferredChainId,
          realizedLpFeePct,
          relayerFeePct,
          gasCost,
          gasLimit,
        };
      } else {
        // If preferred chain is not profitable and neither is fallback, then return the original profitability result.
        this.logger.debug({
          at: "Relayer",
          message: `Taking repayment on destination chain ${destinationChainId} would also not be profitable.`,
          deposit: {
            originChain,
            depositId,
            destinationChain,
            transactionHash,
            token: hubPoolToken.symbol,
            inputAmount,
            outputAmount,
          },
          preferredChain: getNetworkName(preferredChainId),
          preferredChainLpFeePct: `${formatFeePct(realizedLpFeePct)}%`,
          destinationChainLpFeePct: `${formatFeePct(destinationChainLpFeePct)}%`,
          preferredChainRelayerFeePct: `${formatFeePct(relayerFeePct)}%`,
          destinationChainRelayerFeePct: `${formatFeePct(fallbackProfitability.grossRelayerFeePct)}%`,
        });
      }
    }

    this.logger.debug({
      at: "Relayer",
      message: `Preferred chain ${preferredChainId} is${profitable ? "" : " not"} profitable.`,
      deposit: {
        originChain,
        depositId,
        destinationChain,
        transactionHash,
        token: hubPoolToken.symbol,
        inputAmount,
        outputAmount,
      },
      preferredChainLpFeePct: `${formatFeePct(realizedLpFeePct)}%`,
      preferredChainRelayerFeePct: `${formatFeePct(relayerFeePct)}%`,
    });

    return {
      repaymentChainId: profitable ? preferredChainId : undefined,
      realizedLpFeePct,
      relayerFeePct,
      gasCost,
      gasLimit,
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
    const { hubPoolClient, profitClient } = this.clients;
    const unprofitableDeposits = profitClient.getUnprofitableFills();

    const formatAmount = (chainId: number, token: string, amount: BigNumber): { symbol: string; amount: string } => {
      const { symbol, decimals } = hubPoolClient.getL1TokenInfoForL2Token(token, chainId);
      return { symbol, amount: createFormatFunction(2, 4, false, decimals)(amount.toString()) };
    };

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

        const { symbol: inputSymbol, amount: formattedInputAmount } = formatAmount(
          originChainId,
          inputToken,
          inputAmount
        );
        const { symbol: outputSymbol, amount: formattedOutputAmount } = formatAmount(
          destinationChainId,
          outputToken,
          outputAmount
        );

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
      this.logger.warn({ at: "Relayer", message: "Not relaying unprofitable deposits 🙅‍♂️!", mrkdwn });
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
      this.clients.hubPoolClient.getTokenInfoForDeposit(deposit);
    const _outputAmount = createFormatFunction(2, 4, false, outputTokenDecimals)(deposit.outputAmount.toString());
    msg +=
      ` and output ${_outputAmount} ${outputTokenSymbol}, with depositor ${depositor}.` +
      ` Realized LP fee: ${realizedLpFeePct}%, total fee: ${totalFeePct}%.`;

    return msg;
  }
}

import { groupBy } from "lodash";
import { clients as sdkClients, utils as sdkUtils } from "@across-protocol/sdk-v2";
import {
  BigNumber,
  winston,
  buildFillRelayProps,
  getNetworkName,
  getUnfilledDeposits,
  getCurrentTime,
  buildFillRelayWithUpdatedFeeProps,
  isDepositSpedUp,
} from "../utils";
import { createFormatFunction, etherscanLink, formatFeePct, toBN, toBNWei } from "../utils";
import { RelayerClients } from "./RelayerClientHelper";
import { Deposit, DepositWithBlock } from "../interfaces";
import { RelayerConfig } from "./RelayerConfig";

const { UBAActionType } = sdkClients;

const UNPROFITABLE_DEPOSIT_NOTICE_PERIOD = 60 * 60; // 1 hour

export class Relayer {
  // Track by originChainId since depositId is issued on the origin chain.
  // Key is in the form of "chainId-depositId".
  private fullyFilledDeposits: { [key: string]: boolean } = {};

  constructor(
    readonly relayerAddress: string,
    readonly logger: winston.Logger,
    readonly clients: RelayerClients,
    readonly config: RelayerConfig
  ) {}

  async checkForUnfilledDepositsAndFill(sendSlowRelays = true): Promise<void> {
    // Fetch all unfilled deposits, order by total earnable fee.
    // TODO: Note this does not consider the price of the token which will be added once the profitability module is
    // added to this bot.

    const { config } = this;
    const { acrossApiClient, configStoreClient, hubPoolClient, profitClient, spokePoolClients, tokenClient } =
      this.clients;

    const maxVersion = configStoreClient.configStoreVersion;
    const unfilledDeposits = getUnfilledDeposits(spokePoolClients, config.maxRelayerLookBack, configStoreClient);
    const { supportedDeposits = [], unsupportedDeposits = [] } = groupBy(unfilledDeposits, (deposit) =>
      deposit.version <= maxVersion ? "supportedDeposits" : "unsupportedDeposits"
    );

    if (unsupportedDeposits.length > 0) {
      const deposits = unsupportedDeposits.map((unsupported) => {
        const { originChainId, depositId, transactionHash } = unsupported.deposit;
        return { originChainId, depositId, version: unsupported.version, transactionHash };
      });
      this.logger.warn({
        at: "Relayer::checkForUnfilledDepositsAndFill",
        message: "Skipping deposits that are not supported by this relayer version.",
        latestVersionSupported: maxVersion,
        latestInConfigStore: configStoreClient.getConfigStoreVersionForTimestamp(),
        deposits,
      });
    }

    const unfilledDepositAmountsPerChain: { [chainId: number]: BigNumber } = supportedDeposits
      // Sum the total unfilled deposit amount per origin chain and set a MDC for that chain.
      .reduce((agg, curr) => {
        const unfilledAmountUsd = profitClient.getFillAmountInUsd(curr.deposit, curr.unfilledAmount);
        if (!agg[curr.deposit.originChainId]) {
          agg[curr.deposit.originChainId] = toBN(0);
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
      at: "Relayer",
      message: "Setting minimum deposit confirmation based on origin chain aggregate deposit amount",
      unfilledDepositAmountsPerChain,
      mdcPerChain,
      minDepositConfirmations: config.minDepositConfirmations,
    });

    // Filter out deposits that fall under the following criteria:
    // - Deposit age does not meet the minimum number of confirmations for the corresponding origin chain.
    // - quoteTimestamp is in the future (impossible to know HubPool utilization => LP fee cannot be computed).
    const confirmedUnfilledDeposits = unfilledDeposits
      .filter((x) => {
        return (
          x.deposit.quoteTimestamp + config.quoteTimeBuffer <= hubPoolClient.currentTime &&
          x.deposit.blockNumber <=
            spokePoolClients[x.deposit.originChainId].latestBlockNumber - mdcPerChain[x.deposit.originChainId]
        );
      })
      .sort((a, b) =>
        a.unfilledAmount.mul(a.deposit.relayerFeePct).lt(b.unfilledAmount.mul(b.deposit.relayerFeePct)) ? 1 : -1
      );
    if (confirmedUnfilledDeposits.length > 0) {
      this.logger.debug({
        at: "Relayer",
        message: "Unfilled deposits found",
        number: confirmedUnfilledDeposits.length,
      });
    } else {
      this.logger.debug({ at: "Relayer", message: "No unfilled deposits" });
    }

    // Iterate over all unfilled deposits. For each unfilled deposit: a) check that the token balance client has enough
    // balance to fill the unfilled amount. b) the fill is profitable. If both hold true then fill the unfilled amount.
    // If not enough ballance add the shortfall to the shortfall tracker to produce an appropriate log. If the deposit
    // is has no other fills then send a 0 sized fill to initiate a slow relay. If unprofitable then add the
    // unprofitable tx to the unprofitable tx tracker to produce an appropriate log.
    for (const { deposit, version, unfilledAmount, fillCount, invalidFills } of confirmedUnfilledDeposits) {
      const { relayerDestinationChains, relayerTokens, slowDepositors } = config;

      // Skip any L1 tokens that are not specified in the config.
      // If relayerTokens is an empty list, we'll assume that all tokens are supported.
      const l1Token = hubPoolClient.getL1TokenInfoForL2Token(deposit.originToken, deposit.originChainId);
      if (
        relayerTokens.length > 0 &&
        !relayerTokens.includes(l1Token.address) &&
        !relayerTokens.includes(l1Token.address.toLowerCase())
      ) {
        this.logger.debug({ at: "Relayer", message: "Skipping deposit for unwhitelisted token", deposit, l1Token });
        continue;
      }

      const destinationChainId = deposit.destinationChainId;
      const destinationChain = getNetworkName(destinationChainId);
      if (relayerDestinationChains.length > 0 && !relayerDestinationChains.includes(destinationChainId)) {
        this.logger.debug({
          at: "Relayer",
          message: "Skipping deposit for unsupported destination chain",
          deposit,
          destinationChain,
        });
        continue;
      }

      // Skip deposits that contain invalid fills from the same relayer. This prevents potential corrupted data from
      // making the same relayer fill a deposit multiple times.
      if (!config.acceptInvalidFills && invalidFills.some((fill) => fill.relayer === this.relayerAddress)) {
        this.logger.error({
          at: "Relayer",
          message: "👨‍👧‍👦 Skipping deposit with invalid fills from the same relayer",
          deposit,
          invalidFills,
          destinationChain,
        });
        continue;
      }

      // We query the relayer API to get the deposit limits for different token and destination combinations.
      // The relayer should *not* be filling deposits that the HubPool doesn't have liquidity for otherwise the relayer's
      // refund will be stuck for potentially 7 days.
      if (acrossApiClient.updatedLimits && unfilledAmount.gt(acrossApiClient.getLimit(l1Token.address))) {
        this.logger.warn({
          at: "Relayer",
          message: "😱 Skipping deposit with greater unfilled amount than API suggested limit",
          limit: acrossApiClient.getLimit(l1Token.address),
          l1Token: l1Token.address,
          depositId: deposit.depositId,
          amount: deposit.amount,
          unfilledAmount: unfilledAmount.toString(),
          originChainId: deposit.originChainId,
          transactionHash: deposit.transactionHash,
        });
        continue;
      }

      // At this point, check if deposit has a non-empty message.
      // We need to build in better simulation logic for deposits with non-empty messages. Currently we only measure
      // the fill's gas cost against a simple USDC fill with message=0x. This doesn't handle the case where the
      // message is != 0x and it ends up costing a lot of gas to execute, resulting in a big loss to the relayer.
      if (isDepositSpedUp(deposit) && deposit.updatedMessage !== "0x") {
        this.logger.warn({
          at: "Relayer",
          message: "Skipping fill for sped-up deposit with message",
          deposit,
        });
        continue;
      } else if (deposit.message !== "0x") {
        this.logger.warn({
          at: "Relayer",
          message: "Skipping fill for deposit with message",
          deposit,
        });
        continue;
      }

      // If depositor is on the slow deposit list, then send a zero fill to initiate a slow relay and return early.
      if (
        sendSlowRelays &&
        fillCount === 0 &&
        slowDepositors?.includes(deposit.depositor) &&
        tokenClient.hasBalanceForZeroFill(deposit)
      ) {
        this.logger.debug({
          at: "Relayer",
          message: "Initiating slow fill for grey listed depositor",
          depositor: deposit.depositor,
        });
        this.zeroFillDeposit(deposit);
        continue;
      }

      if (tokenClient.hasBalanceForFill(deposit, unfilledAmount)) {
        // The pre-computed realizedLpFeePct is for the pre-UBA fee model. Update it to the UBA fee model if necessary.
        // The SpokePool guarantees the sum of the fees is <= 100% of the deposit amount.
        deposit.realizedLpFeePct = await this.computeRealizedLpFeePct(version, deposit, l1Token.symbol);

        const repaymentChainId = await this.resolveRepaymentChain(deposit, unfilledAmount);
        // @todo: For UBA, compute the anticipated refund fee(s) for *all* candidate refund chain(s).
        const refundFee = await this.computeRefundFee(version, unfilledAmount, repaymentChainId, l1Token.symbol);

        if (profitClient.isFillProfitable(deposit, unfilledAmount, refundFee, l1Token)) {
          this.fillRelay(deposit, unfilledAmount, repaymentChainId);
        } else {
          profitClient.captureUnprofitableFill(deposit, unfilledAmount);
        }
      } else {
        tokenClient.captureTokenShortfallForFill(deposit, unfilledAmount);
        // If we don't have enough balance to fill the unfilled amount and the fill count on the deposit is 0 then send a
        // 1 wei sized fill to ensure that the deposit is slow relayed. This only needs to be done once.
        if (sendSlowRelays && tokenClient.hasBalanceForZeroFill(deposit) && fillCount === 0) {
          this.zeroFillDeposit(deposit);
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

  fillRelay(deposit: Deposit, fillAmount: BigNumber, repaymentChainId: number): void {
    // Skip deposits that this relayer has already filled completely before to prevent double filling (which is a waste
    // of gas as the second fill would fail).
    // TODO: Handle the edge case scenario where the first fill failed due to transient errors and needs to be retried
    const fillKey = `${deposit.originChainId}-${deposit.depositId}`;
    if (this.fullyFilledDeposits[fillKey]) {
      this.logger.debug({
        at: "Relayer",
        message: "Skipping deposits already filled by this relayer",
        originChainId: deposit.originChainId,
        depositId: deposit.depositId,
      });
      return;
    }

    this.logger.debug({ at: "Relayer", message: "Filling deposit", deposit, repaymentChainId });
    // If deposit has been sped up, call fillRelayWithUpdatedFee instead. This guarantees that the relayer wouldn't
    // accidentally double fill due to the deposit hash being different - SpokePool contract will check that the
    // original hash with the old fee hasn't been filled.
    if (isDepositSpedUp(deposit)) {
      this.clients.multiCallerClient.enqueueTransaction({
        contract: this.clients.spokePoolClients[deposit.destinationChainId].spokePool, // target contract
        chainId: deposit.destinationChainId,
        method: "fillRelayWithUpdatedDeposit",
        args: buildFillRelayWithUpdatedFeeProps(deposit, repaymentChainId, fillAmount), // props sent with function call.
        message: fillAmount.eq(deposit.amount)
          ? "Relay instantly sent with modified fee 🚀"
          : "Instantly completed relay with modified fee 📫", // message sent to logger.
        mrkdwn:
          this.constructRelayFilledMrkdwn(deposit, repaymentChainId, fillAmount) +
          `Modified relayer fee: ${formatFeePct(deposit.newRelayerFeePct)}%.`, // message details mrkdwn
      });
    } else {
      // Add the fill transaction to the multiCallerClient so it will be executed with the next batch.
      this.clients.multiCallerClient.enqueueTransaction({
        contract: this.clients.spokePoolClients[deposit.destinationChainId].spokePool, // target contract
        chainId: deposit.destinationChainId,
        method: "fillRelay", // method called.
        args: buildFillRelayProps(deposit, repaymentChainId, fillAmount), // props sent with function call.
        message: fillAmount.eq(deposit.amount) ? "Relay instantly sent 🚀" : "Instantly completed relay 📫", // message sent to logger.
        mrkdwn: this.constructRelayFilledMrkdwn(deposit, repaymentChainId, fillAmount), // message details mrkdwn
      });
    }

    // TODO: Revisit in the future when we implement partial fills.
    this.fullyFilledDeposits[fillKey] = true;

    // Decrement tokens in token client used in the fill. This ensures that we dont try and fill more than we have.
    this.clients.tokenClient.decrementLocalBalance(deposit.destinationChainId, deposit.destinationToken, fillAmount);
  }

  zeroFillDeposit(deposit: Deposit): void {
    // We can only overwrite repayment chain ID if we can fully fill the deposit.
    const repaymentChainId = deposit.destinationChainId;
    const fillAmount = toBN(1); // 1 wei; smallest fill size possible.
    this.logger.debug({ at: "Relayer", message: "Zero filling", deposit, repaymentChain: repaymentChainId });
    try {
      // Note: Ignore deposit.newRelayerFeePct because slow relay leaves use a 0% relayer fee if executed.

      // Add the zero fill fill transaction to the multiCallerClient so it will be executed with the next batch.
      this.clients.multiCallerClient.enqueueTransaction({
        contract: this.clients.spokePoolClients[deposit.destinationChainId].spokePool, // target contract
        chainId: deposit.destinationChainId,
        method: "fillRelay", // method called.
        args: buildFillRelayProps(deposit, repaymentChainId, fillAmount), // props sent with function call.
        message: "Zero size relay sent 🐌", // message sent to logger.
        mrkdwn: this.constructZeroSizeFilledMrkdwn(deposit), // message details mrkdwn
      });
      this.clients.tokenClient.decrementLocalBalance(deposit.destinationChainId, deposit.destinationToken, fillAmount);
    } catch (error) {
      this.logger.error({
        at: "Relayer",
        message: "Error creating zeroFillRelayTx",
        error,
        notificationPath: "across-error",
      });
    }
  }

  protected async resolveRepaymentChain(deposit: Deposit, fillAmount: BigNumber): Promise<number> {
    // TODO: Consider adding some way for Relayer to delete transactions in Queue for fills for same deposit.
    // This way the relayer could set a repayment chain ID for any fill that follows a 1 wei fill in the queue.
    // This isn't implemented due to complexity because its a very rare case in production, because its very
    // unlikely that a relayer could enqueue a 1 wei fill (lacking balance to fully fill it) for a deposit and
    // then later on in the run have enough balance to fully fill it.
    const fillsInQueueForSameDeposit = this.clients.multiCallerClient
      .getQueuedTransactions(deposit.destinationChainId)
      .some((tx) => {
        const { method, args } = tx;
        const { depositId, originChainId } = deposit;
        return (
          (method === "fillRelay" && args[9] === depositId && args[6] === originChainId) ||
          (method === "fillRelayWithUpdatedDeposit" && args[11] === depositId && args[7] === originChainId)
        );
      });

    // Fetch the repayment chain from the inventory client. Sanity check that it is one of the known chainIds.
    // We can only overwrite repayment chain ID if we can fully fill the deposit.
    let repaymentChainId = deposit.destinationChainId;

    if (fillAmount.eq(deposit.amount) && !fillsInQueueForSameDeposit) {
      const destinationChainId = deposit.destinationChainId.toString();
      repaymentChainId = await this.clients.inventoryClient.determineRefundChainId(deposit);
      if (!Object.keys(this.clients.spokePoolClients).includes(destinationChainId)) {
        throw new Error("Fatal error! Repayment chain set to a chain that is not part of the defined sets of chains!");
      }
    } else {
      this.logger.debug({ at: "Relayer", message: "Skipping repayment chain determination for partial fill" });
    }

    return repaymentChainId;
  }

  protected async computeRealizedLpFeePct(
    version: number,
    deposit: Deposit,
    symbol: string,
    hubPoolBlockNumber?: number
  ): Promise<BigNumber> {
    if (!sdkUtils.isUBA(version)) {
      return deposit.realizedLpFeePct;
    }

    const { hubPoolClient, ubaClient } = this.clients;
    hubPoolBlockNumber ??= hubPoolClient.latestBlockNumber;

    const { originChainId, depositId, destinationChainId, amount } = deposit;
    const { lpFee, depositBalancingFee: depositFee, systemFee: realizedLpFeePct } = await ubaClient.computeSystemFee(
      originChainId,
      destinationChainId,
      symbol,
      amount,
      hubPoolBlockNumber
    );

    const chain = getNetworkName(deposit.originChainId);
    this.logger.debug({
      at: "relayer::computeRealizedLpFeePct",
      message: `Computed UBA system fee for ${chain} depositId ${depositId}: ${realizedLpFeePct}`,
      lpFee,
      depositFee,
    });

    return realizedLpFeePct;
  }

  protected async computeRefundFee(
    version: number,
    unfilledAmount: BigNumber,
    refundChainId: number,
    symbol: string,
    hubPoolBlockNumber?: number
  ): Promise<BigNumber | undefined> {
    if (!sdkUtils.isUBA(version)) {
      return toBN(0);
    }

    const { hubPoolClient, ubaClient } = this.clients;
    const { balancingFee } = await ubaClient.computeBalancingFee(
      symbol,
      unfilledAmount,
      hubPoolBlockNumber ?? hubPoolClient.latestBlockNumber,
      refundChainId,
      UBAActionType.Refund
    );

    return balancingFee;
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
        const unprofitableDeposit = unprofitableDeposits[chainId][depositId];
        const deposit: DepositWithBlock = unprofitableDeposit.deposit;
        const fillAmount: BigNumber = unprofitableDeposit.fillAmount;
        // Skip notifying if the unprofitable fill happened too long ago to avoid spamming.
        if (deposit.quoteTimestamp + UNPROFITABLE_DEPOSIT_NOTICE_PERIOD < getCurrentTime()) {
          return;
        }

        const gasCost = this.clients.profitClient.getTotalGasCost(deposit.destinationChainId).toString();
        const { symbol, decimals } = this.clients.hubPoolClient.getTokenInfoForDeposit(deposit);
        const formatFunction = createFormatFunction(2, 4, false, decimals);
        const gasFormatFunction = createFormatFunction(2, 10, false, 18);
        const depositEtherscanLink = etherscanLink(deposit.transactionHash, deposit.originChainId);
        depositMrkdwn +=
          `- DepositId ${deposit.depositId} (tx: ${depositEtherscanLink}) of amount ${formatFunction(
            deposit.amount.toString()
          )} ${symbol}` +
          ` with a relayerFeePct ${formatFeePct(deposit.relayerFeePct)}% and gas cost ${gasFormatFunction(gasCost)}` +
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
    return (
      this.constructBaseFillMarkdown(deposit, fillAmount) + `Relayer repayment: ${getNetworkName(repaymentChainId)}.`
    );
  }

  private constructZeroSizeFilledMrkdwn(deposit: Deposit): string {
    return (
      this.constructBaseFillMarkdown(deposit, toBN(0)) +
      "Has been relayed with 0 size due to a token shortfall! This will initiate a slow relay for this deposit."
    );
  }

  private constructBaseFillMarkdown(deposit: Deposit, fillAmount: BigNumber): string {
    const { symbol, decimals } = this.clients.hubPoolClient.getTokenInfoForDeposit(deposit);
    return (
      `Relayed depositId ${deposit.depositId} from ${getNetworkName(deposit.originChainId)} ` +
      `to ${getNetworkName(deposit.destinationChainId)} of ` +
      `${createFormatFunction(2, 4, false, decimals)(deposit.amount.toString())} ${symbol}. ` +
      `with depositor ${etherscanLink(deposit.depositor, deposit.originChainId)}. ` +
      `Fill amount of ${createFormatFunction(2, 4, false, decimals)(fillAmount.toString())} ${symbol} with ` +
      `relayerFee ${formatFeePct(deposit.relayerFeePct)}% & ` +
      `realizedLpFee ${formatFeePct(deposit.realizedLpFeePct)}%. `
    );
  }
}

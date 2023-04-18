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
import { Deposit } from "../interfaces";
import { RelayerConfig } from "./RelayerConfig";
import { CONFIG_STORE_VERSION } from "../common";

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

    const unfilledDeposits = getUnfilledDeposits(
      this.clients.spokePoolClients,
      this.config.maxRelayerLookBack,
      this.clients.configStoreClient
    );
    if (unfilledDeposits.some((x) => x.requiresNewConfigStoreVersion)) {
      this.logger.warn({
        at: "Relayer",
        message: "Skipping some deposits because ConfigStore version is not updated, are you using the latest code?",
        latestVersionSupported: CONFIG_STORE_VERSION,
        latestInConfigStore: this.clients.configStoreClient.getConfigStoreVersionForTimestamp(),
      });
    }

    const unfilledDepositAmountsPerChain: { [chainId: number]: BigNumber } = unfilledDeposits
      .filter((x) => !x.requiresNewConfigStoreVersion)
      // Sum the total unfilled deposit amount per origin chain and set a MDC for that chain.
      .reduce((agg, curr) => {
        const unfilledAmountUsd = this.clients.profitClient.getFillAmountInUsd(curr.deposit, curr.unfilledAmount);
        if (!agg[curr.deposit.originChainId]) {
          agg[curr.deposit.originChainId] = toBN(0);
        }
        agg[curr.deposit.originChainId] = agg[curr.deposit.originChainId].add(unfilledAmountUsd);
        return agg;
      }, {});

    // Sort thresholds in ascending order.
    const minimumDepositConfirmationThresholds = Object.keys(this.config.minDepositConfirmations)
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
        return [
          chainId,
          usdThreshold === undefined
            ? this.config.minDepositConfirmations["default"][chainId]
            : this.config.minDepositConfirmations[usdThreshold][chainId],
        ];
      })
    );
    this.logger.debug({
      at: "Relayer",
      message: "Setting minimum deposit confirmation based on origin chain aggregate deposit amount",
      unfilledDepositAmountsPerChain,
      mdcPerChain,
      minDepositConfirmations: this.config.minDepositConfirmations,
    });

    // Remove deposits whose deposit quote timestamp is > HubPool's current time, because there is a risk that
    // the ConfigStoreClient's computed realized lp fee % is incorrect for quote times in the future. The client
    // would use the current utilization as an input to compute this fee %, but if the utilization is different for the
    // actual block that is mined at the deposit quote time, then the fee % would be different. This should not
    // impact the bridge users' UX in the normal path because deposit UI's have no reason to set quote times in the
    // future.
    const latestHubPoolTime = this.clients.hubPoolClient.currentTime;

    // Require that all fillable deposits meet the minimum specified number of confirmations.
    const confirmedUnfilledDeposits = unfilledDeposits
      .filter((x) => {
        return (
          x.deposit.quoteTimestamp + this.config.quoteTimeBuffer <= latestHubPoolTime &&
          x.deposit.blockNumber <=
            this.clients.spokePoolClients[x.deposit.originChainId].latestBlockNumber -
              mdcPerChain[x.deposit.originChainId]
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
    for (const { deposit, unfilledAmount, fillCount, invalidFills } of confirmedUnfilledDeposits) {
      // Skip any L1 tokens that are not specified in the config.
      // If relayerTokens is an empty list, we'll assume that all tokens are supported.
      const l1Token = this.clients.hubPoolClient.getL1TokenInfoForL2Token(deposit.originToken, deposit.originChainId);
      if (
        this.config.relayerTokens.length > 0 &&
        !this.config.relayerTokens.includes(l1Token.address) &&
        !this.config.relayerTokens.includes(l1Token.address.toLowerCase())
      ) {
        this.logger.debug({ at: "Relayer", message: "Skipping deposit for unwhitelisted token", deposit, l1Token });
        continue;
      }

      const destinationChainId = deposit.destinationChainId;
      if (
        this.config.relayerDestinationChains.length > 0 &&
        !this.config.relayerDestinationChains.includes(destinationChainId)
      ) {
        this.logger.debug({
          at: "Relayer",
          message: "Skipping deposit for unsupported destination chain",
          deposit,
          destinationChain: getNetworkName(destinationChainId),
        });
        continue;
      }

      // Skip deposits that contain invalid fills from the same relayer. This prevents potential corrupted data from
      // making the same relayer fill a deposit multiple times.
      if (!this.config.acceptInvalidFills && invalidFills.some((fill) => fill.relayer === this.relayerAddress)) {
        this.logger.error({
          at: "Relayer",
          message: "👨‍👧‍👦 Skipping deposit with invalid fills from the same relayer",
          deposit,
          invalidFills,
          destinationChain: getNetworkName(destinationChainId),
        });
        continue;
      }

      // We query the relayer API to get the deposit limits for different token and destination combinations.
      // The relayer should *not* be filling deposits that the HubPool doesn't have liquidity for otherwise the relayer's
      // refund will be stuck for potentially 7 days.
      if (
        this.clients.acrossApiClient.updatedLimits &&
        unfilledAmount.gt(this.clients.acrossApiClient.getLimit(l1Token.address))
      ) {
        this.logger.warn({
          at: "Relayer",
          message: "😱 Skipping deposit with greater unfilled amount than API suggested limit",
          limit: this.clients.acrossApiClient.getLimit(l1Token.address),
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
      if (isDepositSpedUp(deposit) && deposit.newMessage !== "0x") {
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
      if (this.clients.tokenClient.hasBalanceForFill(deposit, unfilledAmount)) {
        if (this.clients.profitClient.isFillProfitable(deposit, unfilledAmount, l1Token)) {
          await this.fillRelay(deposit, unfilledAmount);
        } else {
          this.clients.profitClient.captureUnprofitableFill(deposit, unfilledAmount);
        }
      } else {
        this.clients.tokenClient.captureTokenShortfallForFill(deposit, unfilledAmount);
        // If we don't have enough balance to fill the unfilled amount and the fill count on the deposit is 0 then send a
        // 1 wei sized fill to ensure that the deposit is slow relayed. This only needs to be done once.
        if (sendSlowRelays && this.clients.tokenClient.hasBalanceForZeroFill(deposit) && fillCount === 0) {
          this.zeroFillDeposit(deposit);
        }
      }
    }
    // If during the execution run we had shortfalls or unprofitable fills then handel it by producing associated logs.
    if (this.clients.tokenClient.anyCapturedShortFallFills()) {
      this.handleTokenShortfall();
    }
    if (this.clients.profitClient.anyCapturedUnprofitableFills()) {
      this.handleUnprofitableFill();
    }
  }

  async fillRelay(deposit: Deposit, fillAmount: BigNumber): Promise<void> {
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

    try {
      // TODO: Consider adding some way for Relayer to delete transactions in Queue for fills for same deposit.
      // This way the relayer could set a repayment chain ID for any fill that follows a 1 wei fill in the queue.
      // This isn't implemented due to complexity because its a very rare case in production, because its very
      // unlikely that a relayer could enqueue a 1 wei fill (lacking balance to fully fill it) for a deposit and
      // then later on in the run have enough balance to fully fill it.
      const fillsInQueueForSameDeposit =
        this.clients.multiCallerClient.getQueuedTransactions(deposit.destinationChainId).filter((tx) => {
          return (
            (tx.method === "fillRelay" && tx.args[9] === deposit.depositId && tx.args[6] === deposit.originChainId) ||
            (tx.method === "fillRelayWithUpdatedDeposit" &&
              tx.args[11] === deposit.depositId &&
              tx.args[7] === deposit.originChainId)
          );
        }).length > 0;
      // Fetch the repayment chain from the inventory client. Sanity check that it is one of the known chainIds.
      // We can only overwrite repayment chain ID if we can fully fill the deposit.
      let repaymentChain = deposit.destinationChainId;
      if (fillAmount.eq(deposit.amount) && !fillsInQueueForSameDeposit) {
        repaymentChain = await this.clients.inventoryClient.determineRefundChainId(deposit);
        if (!Object.keys(this.clients.spokePoolClients).includes(deposit.destinationChainId.toString())) {
          throw new Error(
            "Fatal error! Repayment chain set to a chain that is not part of the defined sets of chains!"
          );
        }
      } else {
        this.logger.debug({
          at: "Relayer",
          message: "Skipping repayment chain determination for partial fill",
        });
      }

      this.logger.debug({ at: "Relayer", message: "Filling deposit", deposit, repaymentChain });

      // If deposit has been sped up, call fillRelayWithUpdatedFee instead. This guarantees that the relayer wouldn't
      // accidentally double fill due to the deposit hash being different - SpokePool contract will check that the
      // original hash with the old fee hasn't been filled.
      if (isDepositSpedUp(deposit)) {
        this.clients.multiCallerClient.enqueueTransaction({
          contract: this.clients.spokePoolClients[deposit.destinationChainId].spokePool, // target contract
          chainId: deposit.destinationChainId,
          method: "fillRelayWithUpdatedDeposit",
          args: buildFillRelayWithUpdatedFeeProps(deposit, repaymentChain, fillAmount), // props sent with function call.
          message: fillAmount.eq(deposit.amount)
            ? "Relay instantly sent with modified fee 🚀"
            : "Instantly completed relay with modified fee 📫", // message sent to logger.
          mrkdwn:
            this.constructRelayFilledMrkdwn(deposit, repaymentChain, fillAmount) +
            `Modified relayer fee: ${formatFeePct(deposit.newRelayerFeePct)}%.`, // message details mrkdwn
        });
      } else {
        // Add the fill transaction to the multiCallerClient so it will be executed with the next batch.
        this.clients.multiCallerClient.enqueueTransaction({
          contract: this.clients.spokePoolClients[deposit.destinationChainId].spokePool, // target contract
          chainId: deposit.destinationChainId,
          method: "fillRelay", // method called.
          args: buildFillRelayProps(deposit, repaymentChain, fillAmount), // props sent with function call.
          message: fillAmount.eq(deposit.amount) ? "Relay instantly sent 🚀" : "Instantly completed relay 📫", // message sent to logger.
          mrkdwn: this.constructRelayFilledMrkdwn(deposit, repaymentChain, fillAmount), // message details mrkdwn
        });
      }

      // TODO: Revisit in the future when we implement partial fills.
      this.fullyFilledDeposits[fillKey] = true;

      // Decrement tokens in token client used in the fill. This ensures that we dont try and fill more than we have.
      this.clients.tokenClient.decrementLocalBalance(deposit.destinationChainId, deposit.destinationToken, fillAmount);
    } catch (error) {
      this.logger.error({
        at: "Relayer",
        message: "Error creating fillRelayTx",
        error,
        notificationPath: "across-error",
      });
    }
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
        const { deposit, fillAmount } = unprofitableDeposits[chainId][depositId];
        // Skip notifying if the unprofitable fill happened too long ago to avoid spamming.
        if (deposit.quoteTimestamp + UNPROFITABLE_DEPOSIT_NOTICE_PERIOD < getCurrentTime()) {
          return;
        }

        const gasCost = this.clients.profitClient.getTotalGasCost(deposit.destinationChainId).toString();
        const { symbol, decimals } = this.clients.hubPoolClient.getTokenInfoForDeposit(deposit);
        const formatFunction = createFormatFunction(2, 4, false, decimals);
        const gasFormatFunction = createFormatFunction(2, 10, false, 18);
        depositMrkdwn +=
          `- DepositId ${deposit.depositId} of amount ${formatFunction(deposit.amount)} ${symbol}` +
          ` with a relayerFeePct ${formatFeePct(deposit.relayerFeePct)}% and gas cost ${gasFormatFunction(gasCost)}` +
          ` from ${getNetworkName(deposit.originChainId)} to ${getNetworkName(deposit.destinationChainId)}` +
          ` and an unfilled amount of ${formatFunction(fillAmount)} ${symbol} is unprofitable!\n`;
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

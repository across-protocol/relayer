import { BigNumber, winston, buildFillRelayProps, getNetworkName, getUnfilledDeposits, getCurrentTime } from "../utils";
import { createFormatFunction, etherscanLink, toBN } from "../utils";
import { RelayerClients } from "./RelayerClientHelper";

import { Deposit } from "../interfaces";
import { destinationChainId } from "@across-protocol/contracts-v2/dist/test/constants";

const UNPROFITABLE_DEPOSIT_NOTICE_PERIOD = 60 * 60; // 1 hour

export class Relayer {
  private filledDepositsByChain: { [destinationChain: number]: { [depositId: number]: boolean } } = {};

  constructor(
    readonly relayerAddress: string,
    readonly logger: winston.Logger,
    readonly clients: RelayerClients,
    readonly maxUnfilledDepositLookBack: { [chainId: number]: number } = {},
    readonly relayerTokens: string[] = [],
    readonly relayerDestinationChains: number[] = []
  ) {}

  async checkForUnfilledDepositsAndFill(sendSlowRelays = true) {
    // Fetch all unfilled deposits, order by total earnable fee.
    // TODO: Note this does not consider the price of the token which will be added once the profitability module is
    // added to this bot.
    const unfilledDeposits = getUnfilledDeposits(this.clients.spokePoolClients, this.maxUnfilledDepositLookBack).sort(
      (a, b) =>
        a.unfilledAmount.mul(a.deposit.relayerFeePct).lt(b.unfilledAmount.mul(b.deposit.relayerFeePct)) ? 1 : -1
    );
    if (unfilledDeposits.length > 0) {
      this.logger.debug({ at: "Relayer", message: "Unfilled deposits found", number: unfilledDeposits.length });
    } else {
      this.logger.debug({ at: "Relayer", message: "No unfilled deposits" });
    }
    // Iterate over all unfilled deposits. For each unfilled deposit: a) check that the token balance client has enough
    // balance to fill the unfilled amount. b) the fill is profitable. If both hold true then fill the unfilled amount.
    // If not enough ballance add the shortfall to the shortfall tracker to produce an appropriate log. If the deposit
    // is has no other fills then send a 0 sized fill to initiate a slow relay. If unprofitable then add the
    // unprofitable tx to the unprofitable tx tracker to produce an appropriate log.
    for (const { deposit, unfilledAmount, fillCount } of unfilledDeposits) {
      if (this.filledDepositsByChain[deposit.destinationChainId] === undefined) {
        this.filledDepositsByChain[deposit.destinationChainId] = {};
      }
      // Skip deposits that this relayer has already filled to prevent double filling (which is a waste of gas as the
      // second fill would fail).
      // TODO: Handle the edge case scenario where the first fill failed due to transient errors and needs to be retried
      if (this.filledDepositsByChain[deposit.destinationChainId][deposit.depositId]) {
        continue;
      }
      this.filledDepositsByChain[deposit.destinationChainId][deposit.depositId] = true;

      // Skip any L1 tokens that are not specified in the config.
      // If relayerTokens is an empty list, we'll assume that all tokens are supported.
      const l1Token = this.clients.hubPoolClient.getL1TokenInfoForL2Token(deposit.originToken, deposit.originChainId);
      if (
        this.relayerTokens.length > 0 &&
        !this.relayerTokens.includes(l1Token.address) &&
        !this.relayerTokens.includes(l1Token.address.toLowerCase())
      ) {
        this.logger.debug({ at: "Relayer", message: "Skipping deposit for unwhitelisted token", deposit, l1Token });
        continue;
      }

      const destinationChainId = deposit.destinationChainId;
      if (this.relayerDestinationChains.length > 0 && !this.relayerDestinationChains.includes(destinationChainId)) {
        this.logger.debug({
          at: "Relayer",
          message: "Skipping deposit for unsupported destination chain",
          deposit,
          destinationChain: getNetworkName(destinationChainId),
        });
        continue;
      }

      if (this.clients.tokenClient.hasBalanceForFill(deposit, unfilledAmount)) {
        if (this.clients.profitClient.isFillProfitable(deposit, unfilledAmount)) {
          this.fillRelay(deposit, unfilledAmount);
        } else {
          this.clients.profitClient.captureUnprofitableFill(deposit, unfilledAmount);
        }
      } else {
        this.clients.tokenClient.captureTokenShortfallForFill(deposit, unfilledAmount);
        // If we don't have enough balance to fill the unfilled amount and the fill count on the deposit is 0 then send a
        // 1 wei sized fill to ensure that the deposit is slow relayed. This only needs to be done once.
        if (sendSlowRelays && this.clients.tokenClient.hasBalanceForZeroFill(deposit) && fillCount === 0)
          this.zeroFillDeposit(deposit);
      }
    }
    // If during the execution run we had shortfalls or unprofitable fills then handel it by producing associated logs.
    if (this.clients.tokenClient.anyCapturedShortFallFills()) this.handleTokenShortfall();
    if (this.clients.profitClient.anyCapturedUnprofitableFills()) this.handleUnprofitableFill();
  }

  fillRelay(deposit: Deposit, fillAmount: BigNumber) {
    try {
      // Fetch the repayment chain from the inventory client. Sanity check that it is one of the known chainIds.
      const repaymentChain = this.clients.inventoryClient.determineRefundChainId(deposit);
      if (!Object.keys(this.clients.spokePoolClients).includes(deposit.destinationChainId.toString()))
        throw new Error("Fatal error! Repayment chain set to a chain that is not part of the defined sets of chains!");

      this.logger.debug({ at: "Relayer", message: "Filling deposit", deposit, repaymentChain });
      // Add the fill transaction to the multiCallerClient so it will be executed with the next batch.
      this.clients.multiCallerClient.enqueueTransaction({
        contract: this.clients.spokePoolClients[deposit.destinationChainId].spokePool, // target contract
        chainId: deposit.destinationChainId,
        method: "fillRelay", // method called.
        args: buildFillRelayProps(deposit, repaymentChain, fillAmount), // props sent with function call.
        message: "Relay instantly sent 🚀", // message sent to logger.
        mrkdwn: this.constructRelayFilledMrkdwn(deposit, repaymentChain, fillAmount), // message details mrkdwn
      });

      // Decrement tokens in token client used in the fill. This ensures that we dont try and fill more than we have.
      this.clients.tokenClient.decrementLocalBalance(deposit.destinationChainId, deposit.destinationToken, fillAmount);
    } catch (error) {
      console.log("error", error);
      this.logger.error({
        at: "Relayer",
        message: "Error creating fillRelayTx",
        error,
        notificationPath: "across-error",
      });
    }
  }

  zeroFillDeposit(deposit: Deposit) {
    const repaymentChainId = 1; // Always refund zero fills on L1 to not send dust over the chain unnecessarily.
    const fillAmount = toBN(1); // 1 wei; smallest fill size possible.
    this.logger.debug({ at: "Relayer", message: "Zero filling", deposit, repaymentChain: repaymentChainId });
    try {
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
    Object.keys(tokenShortfall).forEach((chainId) => {
      mrkdwn += `*Shortfall on ${getNetworkName(chainId)}:*\n`;
      Object.keys(tokenShortfall[chainId]).forEach((token) => {
        const { symbol, decimals } = this.clients.hubPoolClient.getTokenInfo(chainId, token);
        const formatter = createFormatFunction(2, 4, false, decimals);
        let crossChainLog = "";
        if (this.clients.inventoryClient.isInventoryManagementEnabled() && chainId !== "1") {
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
          `${formatter(tokenShortfall[chainId][token].shortfall)} ` +
          `(have ${formatter(tokenShortfall[chainId][token].balance)} but need ` +
          `${formatter(tokenShortfall[chainId][token].needed)}). ${crossChainLog}` +
          `This is blocking deposits: ${tokenShortfall[chainId][token].deposits}.\n`;
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

        const { symbol, decimals } = this.clients.hubPoolClient.getTokenInfoForDeposit(deposit);
        const formatFunction = createFormatFunction(2, 4, false, decimals);
        depositMrkdwn +=
          `- DepositId ${deposit.depositId} of amount ${formatFunction(deposit.amount)} ${symbol}` +
          ` with a relayerFeePct ${Relayer.formatFeePct(deposit.relayerFeePct)} being relayed from ` +
          `${getNetworkName(deposit.originChainId)} to ${getNetworkName(deposit.destinationChainId)}` +
          ` and an unfilled amount of  ${formatFunction(fillAmount)} ${symbol} is unprofitable!\n`;
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
      `relayerFee ${Relayer.formatFeePct(deposit.relayerFeePct)}% & ` +
      `realizedLpFee ${Relayer.formatFeePct(deposit.realizedLpFeePct)}%. `
    );
  }

  private static formatFeePct(relayerFeePct: BigNumber): string {
    return createFormatFunction(2, 4, false, 18)(toBN(relayerFeePct).mul(100).toString());
  }
}

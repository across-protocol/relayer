import { BigNumber, winston, buildFillRelayProps, getNetworkName, getUnfilledDeposits } from "../utils";
import { createFormatFunction, etherscanLink, toBN } from "../utils";
import { RelayerClients } from "./RelayerClientHelper";

import { Deposit } from "../interfaces/SpokePool";

export class Relayer {
  constructor(readonly logger: winston.Logger, readonly clients: RelayerClients) {}
  async checkForUnfilledDepositsAndFill(sendSlowRelays: Boolean = true) {
    // Fetch all unfilled deposits, order by total earnable fee.
    // TODO: Note this does not consider the price of the token which will be added once the profitability module is
    // added to this bot.
    const unfilledDeposits = getUnfilledDeposits(this.clients.spokePoolClients).sort((a, b) =>
      a.unfilledAmount.mul(a.deposit.relayerFeePct).lt(b.unfilledAmount.mul(b.deposit.relayerFeePct)) ? 1 : -1
    );
    if (unfilledDeposits.length > 0)
      this.logger.debug({ at: "Relayer", message: "Filling deposits", number: unfilledDeposits.length });
    else this.logger.debug({ at: "Relayer", message: "No unfilled deposits" });
    // Iterate over all unfilled deposits. For each unfilled deposit: a) check that the token balance client has enough
    // balance to fill the unfilled amount. b) the fill is profitable. If both hold true then fill the unfilled amount.
    // If not enough ballance add the shortfall to the shortfall tracker to produce an appropriate log. If the deposit
    // is has no other fills then send a 0 sized fill to initiate a slow relay. If unprofitable then add the
    // unprofitable tx to the unprofitable tx tracker to produce an appropriate log.
    for (const { deposit, unfilledAmount, fillCount } of unfilledDeposits) {
      const partialFillAmount = this.clients.inventoryClient.getPartialFillAmount(deposit, unfilledAmount);

      // We make the core assumption: partialFillAmount <= current relayer balance.

      // Deposit doesn't trigger partial fill threshold. Relayer will either send 100% or ~0% of deposit.
      if (partialFillAmount.eq(toBN(0))) {
        if (this.clients.tokenClient.hasBalanceForFill(deposit, unfilledAmount)) {
          // If relayer can do it, then fill 100% of deposit.
          this.fillRelay(deposit, unfilledAmount);
        } else {
          // Otherwise record a shortfall and 1 wei fill it.
          this.clients.tokenClient.captureTokenShortfallForFill(deposit, unfilledAmount);
          if (sendSlowRelays && this.clients.tokenClient.hasBalanceForZeroFill(deposit) && fillCount === 0)
            this.zeroFillDeposit(deposit);
        }
      }
      // Deposit triggers partial fill threshold.
      else {
        // If unfilled amount > partial fill amount, then there is a shortfall and we'll partially fill it.
        if (unfilledAmount.gt(partialFillAmount)) {
          this.clients.tokenClient.captureTokenShortfallForFill(deposit, unfilledAmount.sub(partialFillAmount));
          if (fillCount === 0) this.fillRelay(deposit, partialFillAmount);
        } else {
          // If partial fill amount is >= unfilled amount, then we can just fully fill the deposit and don't need to
          // record a shortfall.
          this.fillRelay(deposit, unfilledAmount);
        }
      }
    }
    // If during the execution run we had shortfalls or unprofitable fills then handel it by producing associated logs.
    if (this.clients.tokenClient.anyCapturedShortFallFills()) this.handleTokenShortfall();
    if (this.clients.profitClient.anyCapturedUnprofitableFills()) this.handleUnprofitableFill();
  }

  fillRelay(deposit: Deposit, fillAmount: BigNumber) {
    try {
      // Fetch the repayment chain from the inventory client. Sanity check that it is one of the known chainIds.
      const repaymentChain = this.clients.inventoryClient.determineRefundChainId(deposit, fillAmount);
      if (!Object.keys(this.clients.spokePoolClients).includes(deposit.destinationChainId.toString()))
        throw new Error("Fatal error! Repayment chain set to a chain that is not part of the defined sets of chains!");

      if (fillAmount.lt(deposit.amount)) {
        this.logger.debug({ at: "Relayer", message: "Partially filling deposit", deposit, repaymentChain });
        this.clients.multiCallerClient.enqueueTransaction({
          contract: this.clients.spokePoolClients[deposit.destinationChainId].spokePool, // target contract
          chainId: deposit.destinationChainId,
          method: "fillRelay", // method called.
          args: buildFillRelayProps(deposit, repaymentChain, fillAmount), // props sent with function call.
          message: "Partial relay sent 🦦", // message sent to logger.
          mrkdwn: this.constructRelayFilledMrkdwn(deposit, repaymentChain, fillAmount), // message details mrkdwn
        });
      } else {
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
      }

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

  // Returns all unfilled deposits over all spokePoolClients. Return values include the amount of the unfilled deposit.
  getUnfilledDeposits(): { deposit: Deposit; unfilledAmount: BigNumber; fillCount: number }[] {
    let unfilledDeposits: { deposit: Deposit; unfilledAmount: BigNumber; fillCount: number }[] = [];
    // Iterate over each chainId and check for unfilled deposits.
    const chainIds = Object.keys(this.clients.spokePoolClients);
    for (const originChain of chainIds) {
      const originClient = this.clients.spokePoolClients[originChain];
      for (const destinationChain of chainIds) {
        if (originChain === destinationChain) continue;
        // Find all unfilled deposits for the current loops originChain -> destinationChain. Note that this also
        // validates that the deposit is filled "correctly" for the given deposit information. This includes validation
        // of the all deposit -> relay props, the realizedLpFeePct and the origin->destination token mapping.
        const destinationClient = this.clients.spokePoolClients[destinationChain];
        const depositsForDestinationChain = originClient.getDepositsForDestinationChain(destinationChain);
        const unfilledDepositsForDestinationChain = depositsForDestinationChain.map((deposit) => {
          return { ...destinationClient.getValidUnfilledAmountForDeposit(deposit), deposit };
        });
        // Remove any deposits that have no unfilled amount and append the remaining deposits to unfilledDeposits array.
        unfilledDeposits.push(...unfilledDepositsForDestinationChain.filter((deposit) => deposit.unfilledAmount.gt(0)));
      }
    }

    return unfilledDeposits;
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
            `There is ` +
            formatter(this.clients.inventoryClient.getOutstandingCrossChainTransferAmount(chainId, l1Token.address)) +
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
      mrkdwn += `*Unprofitable deposits on ${getNetworkName(chainId)}:*\n`;
      Object.keys(unprofitableDeposits[chainId]).forEach((depositId) => {
        const { deposit, fillAmount } = unprofitableDeposits[chainId][depositId];
        const { symbol, decimals } = this.clients.hubPoolClient.getTokenInfoForDeposit(deposit);
        const formatFunction = createFormatFunction(2, 4, false, decimals);
        mrkdwn +=
          `- DepositId ${deposit.depositId} of amount ${formatFunction(deposit.amount)} ${symbol}` +
          ` with a relayerFeePct ${formatFunction(deposit.relayerFeePct)} being relayed from ` +
          `${getNetworkName(deposit.originChainId)} to ${getNetworkName(deposit.destinationChainId)}` +
          ` and an unfilled amount of  ${formatFunction(fillAmount)} ${symbol} is unprofitable!\n`;
      });
    });

    this.logger.warn({ at: "Relayer", message: "Not relaying unprofitable deposits 🙅‍♂️!", mrkdwn });
  }

  private constructRelayFilledMrkdwn(deposit: Deposit, repaymentChainId: number, fillAmount: BigNumber): string {
    return (
      this.constructBaseFillMarkdown(deposit, fillAmount) + `Relayer repayment: ${getNetworkName(repaymentChainId)}.`
    );
  }

  private constructZeroSizeFilledMrkdwn(deposit: Deposit): string {
    return (
      this.constructBaseFillMarkdown(deposit, toBN(0)) +
      `Has been relayed with 0 size due to a token shortfall! This will initiate a slow relay for this deposit.`
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
      `relayerFee ${createFormatFunction(2, 4, false, 18)(toBN(deposit.relayerFeePct).mul(100).toString())}% & ` +
      `realizedLpFee ${createFormatFunction(2, 4, false, 18)(toBN(deposit.realizedLpFeePct).mul(100).toString())}%. `
    );
  }
}

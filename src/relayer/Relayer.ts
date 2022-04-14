import { BigNumber, winston, buildFillRelayProps, getNetworkName } from "../utils";
import { createFormatFunction, etherscanLink } from "../utils";
import { RelayerClients } from "../clients";

import { Deposit } from "../interfaces/SpokePool";

export class Relayer {
  private repaymentChainId = 1; // Set to 1 for now. In future can be dynamically set to adjust bots capital allocation.

  constructor(readonly logger: winston.Logger, readonly clients: RelayerClients) {}
  async checkForUnfilledDepositsAndFill() {
    // Fetch all unfilled deposits, order by total earnable fee.
    // TODO: Note this does not consider the price of the token which will be added once the profitability module is
    // added to this bot.
    const unfilledDeposits = this.getUnfilledDeposits().sort((a, b) =>
      a.unfilledAmount.mul(a.deposit.relayerFeePct).lt(b.unfilledAmount.mul(b.deposit.relayerFeePct)) ? 1 : -1
    );

    if (unfilledDeposits.length > 0)
      this.logger.debug({ at: "Relayer", message: "Filling deposits", number: unfilledDeposits.length });
    else this.logger.debug({ at: "Relayer", message: "No unfilled deposits" });

    // Iterate over all unfilled deposits. For each unfilled deposit: a) check that the token balance client has enough
    // balance to fill the unfilled amount. b) the fill is profitable. If both hold true then fill the unfilled amount.
    // If not enough ballance add the shortfall to the shortfall tracker to produce an appropriate log. If unprofitable
    // then add the unprofitable tx to the unprofitable tx tracker to produce an appropriate log.
    for (const { deposit, unfilledAmount } of unfilledDeposits) {
      if (this.clients.tokenClient.hasSufficientBalanceForFill(deposit, unfilledAmount)) {
        if (this.clients.profitClient.isFillProfitable(deposit, unfilledAmount)) {
          this.fillRelay(deposit, unfilledAmount);
        } else {
          this.clients.profitClient.captureUnprofitableFill(deposit, unfilledAmount);
        }
      } else {
        this.clients.tokenClient.captureTokenShortfallForDeposit(deposit, unfilledAmount);
        // TODO: this should also execute a 0 sized fill.
      }
    }

    // If during the execution run we had shortfalls then handel it by producing an associated log.
    if (this.clients.tokenClient.anyCapturedShortfalls()) this.handleTokenShortfall();
  }

  fillRelay(deposit: Deposit, fillAmount: BigNumber) {
    this.logger.debug({ at: "Relayer", message: "Filling deposit", deposit, repaymentChain: this.repaymentChainId });
    try {
      // Att the fill transaction to the multiCallerClient so it will be executed with the next batch.
      this.clients.multiCallerClient.enqueueTransaction({
        contract: this.clients.spokePoolClients[deposit.destinationChainId].spokePool, // target contract
        chainId: deposit.destinationChainId,
        method: "fillRelay", // method called.
        args: buildFillRelayProps(deposit, this.repaymentChainId, fillAmount), // props sent with function call.
        message: "Relay instantly sent 🚀", // message sent to logger.
        mrkdwn: this.constructRelayFilledMrkdwn(deposit, this.repaymentChainId, fillAmount), // message details mrkdwn
      });

      // Decrement tokens in token client used in the fill. This ensures that we dont try and fill more than we have.
      this.clients.tokenClient.decrementLocalBalance(deposit.destinationChainId, deposit.destinationToken, fillAmount);
    } catch (error) {
      this.logger.error({ at: "Relayer", message: "Error creating fillRelayTx", error });
    }
  }

  // Returns all unfilled deposits over all spokePoolClients. Return values include the amount of the unfilled deposit.
  getUnfilledDeposits(): { deposit: Deposit; unfilledAmount: BigNumber }[] {
    let unfilledDeposits: { deposit: Deposit; unfilledAmount: BigNumber }[] = [];
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
          return { unfilledAmount: destinationClient.getValidUnfilledAmountForDeposit(deposit), deposit };
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
      mrkdwn += `*Shortfall on ${getNetworkName(chainId)}:\n*`;
      Object.keys(tokenShortfall[chainId]).forEach((token) => {
        const { symbol, decimals } = this.clients.hubPoolClient.getTokenInfo(chainId, token);
        const formatFunction = createFormatFunction(2, 4, false, decimals);
        mrkdwn +=
          ` - ${symbol} cumulative shortfall of ` +
          `${formatFunction(tokenShortfall[chainId][token].shortfall)} ` +
          `(have ${formatFunction(tokenShortfall[chainId][token].balance)} but need ` +
          `${formatFunction(tokenShortfall[chainId][token].needed)}). ` +
          `This is blocking deposits: ${tokenShortfall[chainId][token].deposits}\n`;
      });
    });

    this.logger.warn({ at: "Relayer", message: "Insufficient balance to fill all relays 💸!", mrkdwn });

    this.clients.tokenClient.clearTokenShortfall();
  }

  private constructRelayFilledMrkdwn(deposit: Deposit, repaymentChainId: number, fillAmount: BigNumber): string {
    const { symbol, decimals } = this.clients.hubPoolClient.getTokenInfoForDeposit(deposit);
    return (
      `Relayed depositId ${deposit.depositId} from ${getNetworkName(deposit.originChainId)} ` +
      `to ${getNetworkName(deposit.destinationChainId)} of ` +
      `${createFormatFunction(2, 4, false, decimals)(deposit.amount.toString())} ${symbol}. ` +
      `with depositor ${etherscanLink(deposit.depositor, deposit.originChainId)}. ` +
      `Fill amount of ${createFormatFunction(2, 4, false, 18)(fillAmount.toString())} ${symbol} with ` +
      `relayerFee ${createFormatFunction(2, 4, false, 18)(deposit.relayerFeePct.toString())}% & ` +
      `realizedLpFee ${createFormatFunction(2, 4, false, 18)(deposit.realizedLpFeePct.toString())}%.` +
      `Relayer repayment on ${getNetworkName(repaymentChainId)}.`
    );
  }
}

import { BigNumber, winston, buildFillRelayProps, getNetworkName } from "../utils";
import { createFormatFunction, etherscanLink, toBN } from "../utils";
import { RelayerClients } from "./RelayerClientHelper";

import { Deposit } from "../interfaces/SpokePool";

export class Relayer {
  private defaultRepaymentChain = 1;
  constructor(
    readonly logger: winston.Logger,
    readonly clients: RelayerClients,
    readonly repaymentChainIdForToken: { [l1Token: string]: number } = {}
  ) {}

  getRepaymentChainForToken(l1Token: string): number {
    return this.repaymentChainIdForToken[l1Token] ?? this.defaultRepaymentChain;
  }

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
    // If not enough ballance add the shortfall to the shortfall tracker to produce an appropriate log. If the deposit
    // is has no other fills then send a 0 sized fill to initiate a slow relay. If unprofitable then add the
    // unprofitable tx to the unprofitable tx tracker to produce an appropriate log.
    for (const { deposit, unfilledAmount, fillCount } of unfilledDeposits) {
      if (this.clients.tokenClient.hasSufficientBalanceForFill(deposit, unfilledAmount)) {
        if (this.clients.profitClient.isFillProfitable(deposit, unfilledAmount)) {
          this.fillRelay(deposit, unfilledAmount);
        } else {
          this.clients.profitClient.captureUnprofitableFill(deposit, unfilledAmount);
        }
      } else {
        this.clients.tokenClient.captureTokenShortfallForFill(deposit, unfilledAmount);
        // If we dont have enough balance to fill the unfilled amount and the fill count on the deposit is 0 then send a
        // 0 sized fill to ensure that the deposit is slow relayed. This only needs to be done once.
        if (fillCount === 0) this.zeroFillDeposit(deposit);
      }
    }

    // If during the execution run we had shortfalls or unprofitable fills then handel it by producing associated logs.
    if (this.clients.tokenClient.anyCapturedShortFallFills()) this.handleTokenShortfall();
    if (this.clients.profitClient.anyCapturedUnprofitableFills()) this.handleUnprofitableFill();
  }

  fillRelay(deposit: Deposit, fillAmount: BigNumber) {
    const l1Token = this.clients.hubPoolClient.getL1TokenForDeposit(deposit);
    const l1TokenInfo = this.clients.hubPoolClient.getTokenInfoForL1Token(l1Token);
    this.logger.debug({
      at: "Relayer",
      message: `Filling deposit for ${l1TokenInfo.symbol}`,
      deposit,
      repaymentChain: this.getRepaymentChainForToken(l1Token),
      l1Token: l1TokenInfo.symbol,
    });
    try {
      // Add the fill transaction to the multiCallerClient so it will be executed with the next batch.
      this.clients.multiCallerClient.enqueueTransaction({
        contract: this.clients.spokePoolClients[deposit.destinationChainId].spokePool, // target contract
        chainId: deposit.destinationChainId,
        method: "fillRelay", // method called.
        args: buildFillRelayProps(deposit, this.getRepaymentChainForToken(l1Token), fillAmount), // props sent with function call.
        message: `Relay instantly sent for ${l1TokenInfo.symbol} 🚀`, // message sent to logger.
        mrkdwn: this.constructRelayFilledMrkdwn(deposit, this.getRepaymentChainForToken(l1Token), fillAmount), // message details mrkdwn
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
    const l1Token = this.clients.hubPoolClient.getL1TokenForDeposit(deposit);
    const l1TokenInfo = this.clients.hubPoolClient.getTokenInfoForL1Token(l1Token);
    this.logger.debug({
      at: "Relayer",
      message: `Zero filling deposit for ${l1TokenInfo.symbol}`,
      deposit,
      repaymentChain: this.getRepaymentChainForToken(l1Token),
      l1Token: l1TokenInfo.symbol,
    });
    try {
      // Add the zero fill fill transaction to the multiCallerClient so it will be executed with the next batch.
      this.clients.multiCallerClient.enqueueTransaction({
        contract: this.clients.spokePoolClients[deposit.destinationChainId].spokePool, // target contract
        chainId: deposit.destinationChainId,
        method: "fillRelay", // method called.
        args: buildFillRelayProps(deposit, this.getRepaymentChainForToken(l1Token), toBN(1)), // props sent with function call.
        message: `Zero size relay sent ${l1TokenInfo.symbol} 🐌`, // message sent to logger.
        mrkdwn: this.constructZeroSizeFilledMrkdwn(deposit), // message details mrkdwn
      });
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

  // TODO: that the implementations below for both methods will produce logs on each iteration of the bot. This should
  // be refactored to only log ONCE on the first time seeing each log. This will be left for a later PR.

  private handleTokenShortfall() {
    const tokenShortfall = this.clients.tokenClient.getTokenShortfall();

    let mrkdwn = "";
    Object.keys(tokenShortfall).forEach((chainId) => {
      mrkdwn += `*Shortfall on ${getNetworkName(chainId)}:*\n`;
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

    this.logger.warn({ at: "Relayer", message: "Insufficient balance to fill all deposits 💸!", mrkdwn });

    this.clients.tokenClient.clearTokenShortfall();
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

    this.clients.profitClient.clearUnprofitableFills();

    // Note that this implementation right now will result in each run of the bot logging for insufficient token balance.
    // Storing these logs and only emmitting them once will be done in a subsequent PR.
    this.clients.tokenClient.clearTokenShortfall();
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

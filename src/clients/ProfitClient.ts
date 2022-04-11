import { BigNumber, winston, assign, ERC20, toBNWei, toBN, MAX_SAFE_ALLOWANCE } from "../utils";
import { runTransaction, getNetworkName, etherscanLink } from "../utils";
import { HubPoolClient, SpokePoolClient } from ".";
import { Deposit, L1Token } from "../interfaces";
import { Coingecko } from "@uma/sdk";

// Define the minimum revenue, in USD, that a relay must yield in order to be considered "profitable". This is a short
// term solution to enable us to avoid DOS relays that yield negative profits. In the future this should be updated
// to actual factor in the cost of sending transactions on the associated target chains.
const chainIdToMinRevenue = {
  // Mainnet and L1 testnets.
  1: toBNWei(10),
  4: toBNWei(10),
  5: toBNWei(10),
  42: toBNWei(10),
  // Rollups/L2s/sidechains & their testnets.
  10: toBNWei(1),
  69: toBNWei(1),
  288: toBNWei(1),
  28: toBNWei(1),
  42161: toBNWei(1),
  137: toBNWei(1),
  80001: toBNWei(1),
};

export class ProfitClient {
  private readonly coingecko;
  private tokenPrices: { [l1Token: string]: BigNumber } = {};

  constructor(
    readonly logger: winston.Logger,
    readonly hubPoolClient: HubPoolClient,
    readonly relayerDiscount: BigNumber = toBN(0)
  ) {
    this.coingecko = new Coingecko();
  }

  getPriceOfToken(token: string) {
    if (!this.tokenPrices[token]) {
      this.logger.warn({ at: "ProfitClient", message: `Token ${token} not found in state. Using 0` });
      return toBN(0);
    }
    return this.tokenPrices[token];
  }

  isFillProfitable(deposit: Deposit, fillAmount: BigNumber) {
    const { decimals, address: l1Token } = this.hubPoolClient.getTokenInfoForDeposit(deposit);
    const tokenPriceInUsd = this.getPriceOfToken(l1Token);
    const fillRevenueInRelayedToken = deposit.relayerFeePct.mul(fillAmount).div(toBN(10).pow(decimals));
    const fillRevenueInUsd = fillRevenueInRelayedToken.mul(tokenPriceInUsd);
    const discount = toBNWei(1).sub(this.relayerDiscount);
    const minimumAcceptableRevenue = chainIdToMinRevenue[deposit.destinationChainId].mul(discount).div(toBN(1e18));
    const fillProfitable = fillRevenueInUsd.gte(minimumAcceptableRevenue);
    this.logger.debug({
      at: "ProfitClient",
      message: "Considered fill profitability",
      deposit,
      fillAmount,
      tokenPriceInUsd,
      fillRevenueInRelayedToken,
      fillRevenueInUsd,
      minimumAcceptableRevenue,
      discount: this.relayerDiscount,
      fillProfitable,
    });
    return fillProfitable;
  }

  captureUnprofitableFill(deposit: Deposit, fillAmount: BigNumber) {
    console.log("CAPTURED", deposit, fillAmount);
  }

  async update() {
    const l1Tokens = this.hubPoolClient.getL1Tokens();
    const l1TokensOverride = [
      { address: "0xc778417E063141139Fce010982780140Aa0cD5Ab", symbol: "WETH", decimals: 18 },
      { address: "0x4DBCdF9B62e891a7cec5A2568C3F4FAF9E8Abe2b", symbol: "USDC", decimals: 6 },
    ];
    this.logger.debug({ at: "ProfitClient", message: "Updating client", l1Tokens });
    const prices = await Promise.allSettled(
      l1TokensOverride.map((l1Token: L1Token) => this.getTokenPrice(l1Token.address))
    );

    let errors = [];
    for (const [index, priceResponse] of prices.entries()) {
      if (priceResponse.status === "rejected") errors.push(l1Tokens[index]);
      else this.tokenPrices[l1Tokens[index].address] = toBN(priceResponse.value[1]);
    }
    if (errors.length > 0) {
      let mrkdwn = "The following L1 token prices could not be fetched:\n";
      errors.forEach((token: L1Token) => {
        mrkdwn += `- ${token.symbol} Not found. Using last known price of ${this.getPriceOfToken(token.address)}.\n`;
      });
      this.logger.warn({ at: "ProfitClient", message: "Could not fetch all token prices 💳", mrkdwn });
    }
    this.logger.debug({ at: "ProfitClient", message: "Updated client", tokenPrices: this.tokenPrices });
  }

  private async getTokenPrice(token: string) {
    return await this.coingecko.getCurrentPriceByContract(token, "usd");
  }
}

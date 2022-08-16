import { BigNumber, winston, toBNWei, toBN, assign } from "../utils";
import { HubPoolClient } from ".";
import { Deposit, L1Token } from "../interfaces";
import { Coingecko } from "@uma/sdk";

// Copied from @uma/sdk/coingecko. Propose to export export it upstream in the sdk.
type CoinGeckoPrice = {
  address: string;
  timestamp: number;
  price: number;
};

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
  protected tokenPrices: { [l1Token: string]: BigNumber } = {};
  private unprofitableFills: { [chainId: number]: { deposit: Deposit; fillAmount: BigNumber }[] } = {};

  constructor(
    readonly logger: winston.Logger,
    readonly hubPoolClient: HubPoolClient,
    readonly relayerDiscount: BigNumber = toBNWei(0),
    readonly minRelayerFeePct: string = "0"
  ) {
    this.coingecko = new Coingecko();
  }

  getAllPrices() {
    return this.tokenPrices;
  }

  getPriceOfToken(token: string) {
    if (!this.tokenPrices[token]) {
      this.logger.warn({ at: "ProfitClient", message: `Token ${token} not found in state. Using 0` });
      return toBN(0);
    }
    return this.tokenPrices[token];
  }

  getUnprofitableFills() {
    return this.unprofitableFills;
  }

  clearUnprofitableFills() {
    this.unprofitableFills = {};
  }

  isFillProfitable(deposit: Deposit, fillAmount: BigNumber) {
    if (toBN(deposit.relayerFeePct).lt(toBNWei(this.minRelayerFeePct))) {
      this.logger.debug({ at: "ProfitClient", message: "Relayer fee % < 0.03%" });
      return false;
    }

    if (toBN(this.relayerDiscount).eq(toBNWei(1))) {
      this.logger.debug({ at: "ProfitClient", message: "Relayer discount set to 100%. Accepting relay" });
      return true;
    }

    if (toBN(deposit.relayerFeePct).eq(toBN(0))) {
      this.logger.debug({ at: "ProfitClient", message: "Deposit set 0 relayerFeePct. Rejecting relay" });
      return false;
    }

    const { decimals, address: l1Token } = this.hubPoolClient.getTokenInfoForDeposit(deposit);
    const tokenPriceInUsd = this.getPriceOfToken(l1Token);
    const fillRevenueInRelayedToken = toBN(deposit.relayerFeePct).mul(fillAmount).div(toBN(10).pow(decimals));
    const fillRevenueInUsd = fillRevenueInRelayedToken.mul(tokenPriceInUsd).div(toBNWei(1));
    // How much minimumAcceptableRevenue is scaled. If relayer discount is 0 then need minimumAcceptableRevenue at min.
    const revenueScalar = toBNWei(1).sub(this.relayerDiscount);
    const minimumAcceptableRevenue = chainIdToMinRevenue[deposit.destinationChainId].mul(revenueScalar).div(toBNWei(1));
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
    this.logger.debug({ at: "ProfitClient", message: "Handling unprofitable fill", deposit, fillAmount });
    assign(this.unprofitableFills, [deposit.originChainId], [{ deposit, fillAmount }]);
  }

  anyCapturedUnprofitableFills(): boolean {
    return Object.keys(this.unprofitableFills).length != 0;
  }

  async update() {
    const l1Tokens: { [k: string]: L1Token } = Object.fromEntries(
      this.hubPoolClient.getL1Tokens().map((token) => [token["address"], token])
    );

    this.logger.debug({ at: "ProfitClient", message: "Updating Profit client", l1Tokens });
    let cgPrices: Array<CoinGeckoPrice> = [];
    try {
      cgPrices = await this.coingeckoPrices(Object.keys(l1Tokens));
    } catch (err) {
      this.logger.warn({ at: "ProfitClient", message: "Failed to retrieve prices.", err, l1Tokens });
    }

    const errors: Array<{ [k: string]: string }> = [];
    for (const address of Object.keys(l1Tokens)) {
      const tokenPrice: CoinGeckoPrice = cgPrices.find(
        (price) => address.toLowerCase() === price.address.toLowerCase()
      );

      // todo: Any additional validation to do? Ensure that timestamps are always moving forwards?
      if (tokenPrice === undefined || typeof tokenPrice.price !== "number") {
        errors.push({
          address: address,
          symbol: l1Tokens[address].symbol,
          cause: tokenPrice ? "Unexpected price response" : "Missing price",
        });
      } else this.tokenPrices[address] = toBNWei(tokenPrice.price);
    }

    if (errors.length > 0) {
      let mrkdwn = "The following L1 token prices could not be fetched:\n";
      errors.forEach((token: { [k: string]: string }) => {
        mrkdwn += `- ${token["symbol"]} not found (${token["cause"]}).`;
        mrkdwn += ` Using last known price of ${this.getPriceOfToken(token["address"])}.\n`;
      });
      this.logger.warn({ at: "ProfitClient", message: "Could not fetch all token prices 💳", mrkdwn });
    }
    this.logger.debug({ at: "ProfitClient", message: "Updated Profit client", tokenPrices: this.tokenPrices });
  }

  private async coingeckoPrices(tokens: Array<string>) {
    return await this.coingecko.getContractPrices(tokens, "usd");
  }
}

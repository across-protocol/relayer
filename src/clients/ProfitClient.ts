import { Provider } from "@ethersproject/abstract-provider";
import { BigNumber, formatFeePct, winston, toBNWei, toBN, assign } from "../utils";
import { HubPoolClient } from ".";
import { Deposit, L1Token, SpokePoolClientsByChain } from "../interfaces";
import { Coingecko } from "@uma/sdk";
import { relayFeeCalculator } from "@across-protocol/sdk-v2";

// Copied from @uma/sdk/coingecko. Propose to export export it upstream in the sdk.
type CoinGeckoPrice = {
  address: string;
  timestamp: number;
  price: number;
};

// We use wrapped ERC-20 versions instead of the native tokens such as ETH, MATIC for ease of computing prices.
export const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

const GAS_TOKEN_BY_CHAIN_ID = {
  1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
  10: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
  137: WMATIC,
  288: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
  42161: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
};
// TODO: Make this dynamic once we support chains with gas tokens that have different decimals.
const GAS_TOKEN_DECIMALS = 18;

export class ProfitClient {
  private readonly coingecko;
  protected tokenPrices: { [l1Token: string]: BigNumber } = {};
  private unprofitableFills: { [chainId: number]: { deposit: Deposit; fillAmount: BigNumber }[] } = {};

  // Track total gas costs of a relay on each chain.
  protected totalGasCosts: { [chainId: number]: BigNumber } = {};

  // Queries needed to fetch relay gas costs.
  private relayerFeeQueries: { [chainId: number]: relayFeeCalculator.QueryInterface } = {};

  constructor(
    readonly logger: winston.Logger,
    readonly hubPoolClient: HubPoolClient,
    spokePoolClients: SpokePoolClientsByChain,
    readonly enableProfitability: boolean,
    readonly enabledChainIds: number[],
    // Default to throwing errors if fetching token prices fails.
    readonly ignoreTokenPriceFailures: boolean = false,
    readonly minRelayerFeePct: BigNumber = toBN(0)
  ) {
    this.coingecko = new Coingecko();

    for (const chainId of this.enabledChainIds) {
      this.relayerFeeQueries[chainId] = this.constructRelayerFeeQuery(
        chainId,
        spokePoolClients[chainId].spokePool.provider
      );
    }
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

  getTotalGasCost(chainId: number) {
    return this.totalGasCosts[chainId] ?? toBN(0);
  }

  getUnprofitableFills() {
    return this.unprofitableFills;
  }

  clearUnprofitableFills() {
    this.unprofitableFills = {};
  }

  isFillProfitable(deposit: Deposit, fillAmount: BigNumber) {
    if (toBN(deposit.relayerFeePct).lt(this.minRelayerFeePct)) {
      this.logger.debug({
        at: "ProfitClient",
        message: "Relayer fee % < minimum relayer fee %",
        minRelayerFeePct: `${formatFeePct(this.minRelayerFeePct)}%`,
      });
      return false;
    }

    if (toBN(deposit.relayerFeePct).eq(toBN(0))) {
      this.logger.debug({ at: "ProfitClient", message: "Deposit set 0 relayerFeePct. Rejecting relay" });
      return false;
    }

    // This should happen before the previous checks as we don't want to turn them off when profitability is disabled.
    // TODO: Revisit whether this makes sense once we have capital fee evaluation.
    if (!this.enableProfitability) {
      this.logger.debug({ at: "ProfitClient", message: "Profitability check is disabled. Accepting relay" });
      return true;
    }

    const { decimals, address: l1Token } = this.hubPoolClient.getTokenInfoForDeposit(deposit);
    const tokenPriceInUsd = this.getPriceOfToken(l1Token);
    const fillRevenueInRelayedToken = toBN(deposit.relayerFeePct).mul(fillAmount).div(toBN(10).pow(decimals));
    const fillRevenueInUsd = fillRevenueInRelayedToken.mul(tokenPriceInUsd).div(toBNWei(1));

    // Consider gas cost.
    const totalGasCostWei = this.getTotalGasCost(deposit.destinationChainId);
    if (!totalGasCostWei) {
      const chainId = deposit.destinationChainId;
      const errorMsg = `Missing total gas cost for ${chainId}. This likely indicate some gas cost request failed`;
      this.logger.error({
        at: "ProfitClient",
        message: errorMsg,
        allGasCostsFetched: this.totalGasCosts,
        chainId,
      });
      throw new Error(errorMsg);
    }
    const gasCostInUsd = totalGasCostWei
      .mul(this.getPriceOfToken(GAS_TOKEN_BY_CHAIN_ID[deposit.destinationChainId]))
      .div(toBN(10).pow(GAS_TOKEN_DECIMALS));

    // How much minimumAcceptableRevenue is scaled. If relayer discount is 0 then need minimumAcceptableRevenue at min.
    const fillProfitInUsd = fillRevenueInUsd.sub(gasCostInUsd);
    const fillProfitable = fillProfitInUsd.gte(toBN(0));
    this.logger.debug({
      at: "ProfitClient",
      message: "Considered fill profitability",
      deposit,
      fillAmount,
      tokenPriceInUsd,
      fillRevenueInRelayedToken,
      fillRevenueInUsd,
      totalGasCostWei,
      gasCostInUsd,
      fillProfitInUsd,
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
    // Short circuit early if profitability is disabled.
    if (!this.enableProfitability) return;

    const l1Tokens: { [k: string]: L1Token } = Object.fromEntries(
      this.hubPoolClient.getL1Tokens().map((token) => [token["address"], token])
    );

    this.logger.debug({ at: "ProfitClient", message: "Updating Profit client", l1Tokens });
    let cgPrices: CoinGeckoPrice[] = [];
    try {
      const [maticTokenPrice, otherTokenPrices] = await Promise.all([
        // Add WMATIC for gas cost calculations.
        this.coingeckoPrices([WMATIC], "polygon-pos"),
        this.coingeckoPrices(Object.keys(l1Tokens)),
      ]);
      cgPrices = maticTokenPrice.concat(otherTokenPrices);
    } catch (err) {
      this.logger.warn({ at: "ProfitClient", message: "Failed to retrieve prices.", err, l1Tokens });
    }

    // Add to l1Tokens after the fetches, so prices and l1Tokens have the same entries, for any error logging later.
    l1Tokens[WMATIC] = {
      address: WMATIC,
      symbol: "WMATIC",
      decimals: 18,
    };

    const errors: Array<{ [k: string]: string }> = [];
    for (const address of Object.keys(l1Tokens)) {
      const tokenPrice: CoinGeckoPrice = cgPrices.find(
        (price) => address.toLowerCase() === price.address.toLowerCase()
      );

      // TODO: Any additional validation to do? Ensure that timestamps are always moving forwards?
      if (tokenPrice !== undefined && !isNaN(tokenPrice.price)) {
        this.tokenPrices[address] = toBNWei(tokenPrice.price);
      } else {
        errors.push({
          address: address,
          symbol: l1Tokens[address].symbol,
          cause: tokenPrice ? "Unexpected price response" : "Missing price",
        });
      }
    }

    if (errors.length > 0) {
      let mrkdwn = "The following L1 token prices could not be fetched:\n";
      errors.forEach((token: { [k: string]: string }) => {
        mrkdwn += `- ${token["symbol"]} not found (${token["cause"]}).`;
        mrkdwn += ` Using last known price of ${this.getPriceOfToken(token["address"])}.\n`;
      });
      if (this.ignoreTokenPriceFailures) {
        this.logger.warn({ at: "ProfitClient", message: "Could not fetch all token prices 💳", mrkdwn });
      } else {
        this.logger.error({ at: "ProfitClient", message: "Could not fetch all token prices 💳", mrkdwn });
        throw new Error(mrkdwn);
      }
    }

    // Pre-fetch total gas costs for relays on enabled chains.
    const getGasCosts = [];
    for (const chainId of this.enabledChainIds) {
      getGasCosts.push(this.relayerFeeQueries[chainId].getGasCosts());
    }
    const gasCosts = await Promise.all(getGasCosts);
    this.logger.debug({
      at: "ProfitClient",
      message: "Fetched gas costs of relays",
      enabledChainIds: this.enabledChainIds,
      gasCosts,
    });
    for (let i = 0; i < this.enabledChainIds.length; i++) {
      // An extra toBN cast is needed as the provider returns a different BigNumber type.
      this.totalGasCosts[this.enabledChainIds[i]] = toBN(gasCosts[i]);
    }

    this.logger.debug({ at: "ProfitClient", message: "Updated Profit client", tokenPrices: this.tokenPrices });
  }

  protected async coingeckoPrices(tokens: string[], platformId?: string) {
    return await this.coingecko.getContractPrices(tokens, "usd", platformId);
  }

  private constructRelayerFeeQuery(chainId: number, provider: Provider): relayFeeCalculator.QueryInterface {
    // Fallback to Coingecko's free API for now.
    // TODO: Add support for Coingecko Pro.
    const coingeckoProApiKey = undefined;
    // TODO: Set this once we figure out gas markup on the API side.
    const gasMarkup = 0;
    switch (chainId) {
      case 1:
        return new relayFeeCalculator.EthereumQueries(
          provider,
          undefined,
          undefined,
          undefined,
          undefined,
          coingeckoProApiKey,
          this.logger,
          gasMarkup
        );
      case 10:
        return new relayFeeCalculator.OptimismQueries(
          provider,
          undefined,
          undefined,
          undefined,
          undefined,
          coingeckoProApiKey,
          this.logger,
          gasMarkup
        );
      case 137:
        return new relayFeeCalculator.PolygonQueries(
          provider,
          undefined,
          undefined,
          undefined,
          undefined,
          coingeckoProApiKey,
          this.logger,
          gasMarkup
        );
      case 288:
        return new relayFeeCalculator.BobaQueries(
          provider,
          undefined,
          undefined,
          undefined,
          undefined,
          coingeckoProApiKey,
          this.logger,
          gasMarkup
        );
      case 42161:
        return new relayFeeCalculator.ArbitrumQueries(
          provider,
          undefined,
          undefined,
          undefined,
          undefined,
          coingeckoProApiKey,
          this.logger,
          gasMarkup
        );
      default:
        throw new Error(`Unexpected chain ${chainId}`);
    }
  }
}

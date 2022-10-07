import { Provider } from "@ethersproject/abstract-provider";
import * as constants from "../common/Constants";
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
// @todo: These don't belong in the ProfitClient; they should be relocated.
export const MATIC = "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0";
export const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

const GAS_TOKEN_BY_CHAIN_ID: { [chainId: number]: string } = {
  1: WETH,
  10: WETH,
  137: MATIC,
  288: WETH,
  42161: WETH,
};
// TODO: Make this dynamic once we support chains with gas tokens that have different decimals.
const GAS_TOKEN_DECIMALS = 18;

// Note: the type here assumes that all of these classes take the same constructor parameters.
const QUERY_HANDLERS: {
  [chainId: number]: new (
    ...args: ConstructorParameters<typeof relayFeeCalculator.EthereumQueries>
  ) => relayFeeCalculator.QueryInterface;
} = {
  1: relayFeeCalculator.EthereumQueries,
  10: relayFeeCalculator.OptimismQueries,
  137: relayFeeCalculator.PolygonQueries,
  288: relayFeeCalculator.BobaQueries,
  42161: relayFeeCalculator.ArbitrumQueries,
};

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
    readonly ignoreProfitability: boolean,
    readonly enabledChainIds: number[],
    // Default to throwing errors if fetching token prices fails.
    readonly ignoreTokenPriceFailures: boolean = false,
    readonly minRelayerFeePct: BigNumber = toBN(constants.RELAYER_MIN_FEE_PCT)
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
    // Warn on this initially, and move to an assert() once any latent issues are resolved.
    // assert(this.tokenPrices[token] !== undefined, `Token ${token} not in price list.`);
    if (this.tokenPrices[token] === undefined) {
      this.logger.warn({ at: "ProfitClient#getPriceOfToken", message: `Token ${token} not in price list.` });
      return toBN(0);
    }
    return this.tokenPrices[token];
  }

  getTotalGasCost(chainId: number): BigNumber {
    // TODO: Figure out where the mysterious BigNumber -> string conversion happens.
    return this.totalGasCosts[chainId] ? toBN(this.totalGasCosts[chainId]) : toBN(0);
  }

  getUnprofitableFills() {
    return this.unprofitableFills;
  }

  clearUnprofitableFills() {
    this.unprofitableFills = {};
  }

  isFillProfitable(deposit: Deposit, fillAmount: BigNumber) {
    const newRelayerFeePct = toBN(deposit.newRelayerFeePct ?? 0);
    let relayerFeePct = toBN(deposit.relayerFeePct);
    // Use the maximum between the original newRelayerFeePct and any updated fee from speedups.
    if (relayerFeePct.lt(newRelayerFeePct)) {
      relayerFeePct = newRelayerFeePct;
    }

    if (relayerFeePct.lt(this.minRelayerFeePct)) {
      this.logger.debug({
        at: "ProfitClient",
        message: "Relayer fee % < minimum relayer fee %",
        minRelayerFeePct: `${formatFeePct(this.minRelayerFeePct)}%`,
      });
      return false;
    }

    if (relayerFeePct.eq(toBN(0))) {
      this.logger.debug({ at: "ProfitClient", message: "Deposit set 0 relayerFeePct. Rejecting relay" });
      return false;
    }

    // This should happen after the previous checks as we don't want to turn them off when profitability is disabled.
    // TODO: Revisit whether this makes sense once we have capital fee evaluation.
    if (this.ignoreProfitability) {
      this.logger.debug({ at: "ProfitClient", message: "Profitability check is disabled. Accepting relay" });
      return true;
    }

    const l1TokenInfo = this.hubPoolClient.getTokenInfoForDeposit(deposit);
    if (!l1TokenInfo)
      throw new Error(
        `ProfitClient::isFillProfitable missing l1TokenInfo for deposit with origin token: ${deposit.originToken}`
      );
    const { decimals, address: l1Token } = l1TokenInfo;
    const tokenPriceInUsd = this.getPriceOfToken(l1Token);
    const fillRevenueInRelayedToken = relayerFeePct.mul(fillAmount).div(toBN(10).pow(decimals));
    const fillRevenueInUsd = fillRevenueInRelayedToken.mul(tokenPriceInUsd).div(toBNWei(1));

    // Consider gas cost.
    const totalGasCostWei = this.getTotalGasCost(deposit.destinationChainId);
    if (totalGasCostWei.eq(toBN(0))) {
      const chainId = deposit.destinationChainId;
      const errorMsg = `Missing total gas cost for ${chainId}. This likely indicates some gas cost request failed`;
      this.logger.warn({
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
    // Generate list of tokens to retrieve.
    const newTokens: string[] = [];
    const l1Tokens: { [k: string]: L1Token } = Object.fromEntries(
      this.hubPoolClient.getL1Tokens().map((token) => [token["address"], token])
    );

    // Also include MATIC in the price queries as we need it for gas cost calculation.
    l1Tokens[MATIC] = {
      address: MATIC,
      symbol: "MATIC",
      decimals: 18,
    };

    this.logger.debug({ at: "ProfitClient", message: "Updating Profit client", tokens: Object.values(l1Tokens) });

    // Pre-populate any new addresses.
    Object.values(l1Tokens).forEach((token: L1Token) => {
      const { address, symbol } = token;
      if (this.tokenPrices[address] === undefined) {
        this.tokenPrices[address] = toBN(0);
        newTokens.push(symbol);
      }
    });

    if (newTokens.length > 0) {
      this.logger.debug({
        at: "ProfitClient",
        message: "Initialised tokens to price 0.",
        tokens: newTokens.join(", "),
      });
    }

    let cgPrices: CoinGeckoPrice[] = [];
    try {
      cgPrices = await this.coingeckoPrices(Object.keys(l1Tokens));
    } catch (err) {
      const errMsg = `Failed to retrieve token prices (${err})`;
      const tokens = Object.values(l1Tokens)
        .map((token: L1Token) => token.symbol)
        .join(", ");

      if (!this.ignoreTokenPriceFailures) {
        throw new Error(errMsg);
      }
      this.logger.warn({ at: "ProfitClient", message: errMsg, tokens: tokens });
      return;
    }

    const errors: { address: string; symbol: string; cause: string }[] = [];
    Object.keys(l1Tokens).forEach((address: string) => {
      const tokenPrice = cgPrices.find((price) => address.toLowerCase() === price.address.toLowerCase());

      // todo: For future, confirm timestamp is only X seconds old and is newer than the previous?
      //       This should implicitly be factored in if/when price feed caching is introduced.
      if (tokenPrice !== undefined && !isNaN(tokenPrice.price)) {
        this.tokenPrices[address] = toBNWei(tokenPrice.price);
      } else {
        errors.push({
          address: address,
          symbol: l1Tokens[address].symbol,
          cause: tokenPrice ? "Unexpected price response" : "Missing price",
        });
      }
    });

    if (errors.length > 0) {
      let mrkdwn = "The following L1 token prices could not be fetched:\n";
      errors.forEach((token: { address: string; symbol: string; cause: string }) => {
        mrkdwn += `- ${token["symbol"]} not found (${token["cause"]}).`;
        mrkdwn += ` Using last known price of ${this.getPriceOfToken(token["address"])}.\n`;
      });
      this.logger.warn({ at: "ProfitClient", message: "Could not fetch all token prices 💳", mrkdwn });
      if (!this.ignoreTokenPriceFailures) {
        throw new Error(mrkdwn);
      }
    }
    this.logger.debug({ at: "ProfitClient", message: "Updated token prices", tokenPrices: this.tokenPrices });

    // Short circuit early if profitability is disabled. We still need to fetch CG prices but don't need to fetch gas
    // costs of relays.
    if (this.ignoreProfitability) return;

    // Pre-fetch total gas costs for relays on enabled chains.
    const gasCosts = await Promise.all(
      this.enabledChainIds.map((chainId) => this.relayerFeeQueries[chainId].getGasCosts())
    );
    for (let i = 0; i < this.enabledChainIds.length; i++) {
      // An extra toBN cast is needed as the provider returns a different BigNumber type.
      this.totalGasCosts[this.enabledChainIds[i]] = toBN(gasCosts[i]);
    }

    this.logger.debug({
      at: "ProfitClient",
      message: "Updated gas cost",
      enabledChainIds: this.enabledChainIds,
      totalGasCosts: this.totalGasCosts,
    });
  }

  protected async coingeckoPrices(tokens: string[]) {
    return await this.coingecko.getContractPrices(tokens, "usd");
  }

  private constructRelayerFeeQuery(chainId: number, provider: Provider): relayFeeCalculator.QueryInterface {
    // Fallback to Coingecko's free API for now.
    // TODO: Add support for Coingecko Pro.
    const coingeckoProApiKey = undefined;
    // TODO: Set this once we figure out gas markup on the API side.
    const gasMarkup = 0;
    return new QUERY_HANDLERS[chainId](
      provider,
      undefined,
      undefined,
      undefined,
      undefined,
      coingeckoProApiKey,
      this.logger,
      gasMarkup
    );
  }
}

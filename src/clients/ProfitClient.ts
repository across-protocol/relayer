import { random } from "lodash";
import { Provider } from "@ethersproject/abstract-provider";
import { utils as ethersUtils } from "ethers";
import {
  constants as sdkConsts,
  priceClient,
  relayFeeCalculator,
  typeguards,
  utils as sdkUtils,
} from "@across-protocol/sdk-v2";
import * as constants from "../common/Constants";
import {
  assert,
  bnZero,
  bnOne,
  bnUint32Max as uint32Max,
  bnUint256Max as uint256Max,
  fixedPointAdjustment as fixedPoint,
  BigNumber,
  formatFeePct,
  getCurrentTime,
  isDefined,
  max,
  winston,
  toBNWei,
  toBN,
  assign,
  CHAIN_IDs,
  TOKEN_SYMBOLS_MAP,
} from "../utils";
import { Deposit, DepositWithBlock, L1Token, SpokePoolClientsByChain, v2Deposit } from "../interfaces";
import { HubPoolClient } from ".";

type TransactionCostEstimate = sdkUtils.TransactionCostEstimate;

const { isError, isEthersError } = typeguards;
const { formatEther } = ethersUtils;
const {
  EMPTY_MESSAGE,
  DEFAULT_SIMULATED_RELAYER_ADDRESS: PROD_RELAYER,
  DEFAULT_SIMULATED_RELAYER_ADDRESS_TEST: TEST_RELAYER,
} = sdkConsts;
const { getNativeTokenSymbol, isMessageEmpty, resolveDepositMessage } = sdkUtils;

const bn10 = toBN(10);

// @note All FillProfit BigNumbers are scaled to 18 decimals unless specified otherwise.
export type FillProfit = {
  grossRelayerFeePct: BigNumber; // Max of relayerFeePct and newRelayerFeePct from Deposit.
  tokenPriceUsd: BigNumber; // Resolved USD price of the bridged token.
  fillAmountUsd: BigNumber; // Amount of the bridged token being filled.
  grossRelayerFeeUsd: BigNumber; // USD value of the relay fee paid by the user.
  nativeGasCost: BigNumber; // Cost of completing the fill in the units of gas.
  tokenGasCost: BigNumber; // Cost of completing the fill in the relevant gas token.
  gasPadding: BigNumber; // Positive padding applied to nativeGasCost and tokenGasCost before profitability.
  gasMultiplier: BigNumber; // Multiplier applied to token-only fill cost estimates before profitability.
  gasTokenPriceUsd: BigNumber; // Price paid per unit of gas the gas token in USD.
  gasCostUsd: BigNumber; // Estimated cost of completing the fill in USD.
  refundFeeUsd: BigNumber; // Estimated relayer refund fee on the refund chain.
  relayerCapitalUsd: BigNumber; // Amount to be sent by the relayer in USD.
  netRelayerFeePct: BigNumber; // Relayer fee after gas costs as a portion of relayerCapitalUsd.
  netRelayerFeeUsd: BigNumber; // Relayer fee in USD after paying for gas costs.
  profitable: boolean; // Fill profitability indicator.
};

type UnprofitableFill = {
  deposit: DepositWithBlock;
  fillAmount: BigNumber;
  gasCost: BigNumber;
  nativeGasCost: BigNumber;
};

// @dev This address is known on each chain and has previously been used to simulate Deposit gas costs.
// Since _some_ known recipient address is needed for simulating a fill, default to this one. nb. Since
// the SpokePool implements custom behaviour when relayer === recipient, it's important not to use the
// relayer's own address. The specified address is deliberately setup by RL to have a 0 token balance.
const TEST_RECIPIENT = "0xBb23Cd0210F878Ea4CcA50e9dC307fb0Ed65Cf6B";

// These are used to simulate fills on L2s to return estimated gas costs.
// Note: the type here assumes that all of these classes take the same constructor parameters.
const QUERY_HANDLERS: {
  [chainId: number]: new (
    ...args: ConstructorParameters<typeof relayFeeCalculator.BaseQueries>
  ) => relayFeeCalculator.QueryInterface;
} = {
  1: relayFeeCalculator.EthereumQueries,
  10: relayFeeCalculator.OptimismQueries,
  137: relayFeeCalculator.PolygonQueries,
  288: relayFeeCalculator.BobaQueries,
  324: relayFeeCalculator.ZkSyncQueries,
  42161: relayFeeCalculator.ArbitrumQueries,
  8453: relayFeeCalculator.BaseQueries,
  // Testnets:
  5: relayFeeCalculator.EthereumGoerliQueries,
  280: relayFeeCalculator.zkSyncGoerliQueries,
  420: relayFeeCalculator.OptimismGoerliQueries,
  80001: relayFeeCalculator.PolygonMumbaiQueries,
  84531: relayFeeCalculator.BaseGoerliQueries,
  421613: relayFeeCalculator.ArbitrumGoerliQueries,
};

const { PriceClient } = priceClient;
const { acrossApi, coingecko, defiLlama } = priceClient.adapters;

export class ProfitClient {
  private readonly priceClient;
  protected minRelayerFees: { [route: string]: BigNumber } = {};
  protected tokenSymbolMap: { [symbol: string]: string } = {};
  protected tokenPrices: { [address: string]: BigNumber } = {};
  private unprofitableFills: { [chainId: number]: UnprofitableFill[] } = {};

  // Track total gas costs of a relay on each chain.
  protected totalGasCosts: { [chainId: number]: TransactionCostEstimate } = {};

  // Queries needed to fetch relay gas costs.
  private relayerFeeQueries: { [chainId: number]: relayFeeCalculator.QueryInterface } = {};

  private readonly isTestnet: boolean;

  // @todo: Consolidate this set of args before it grows legs and runs away from us.
  constructor(
    readonly logger: winston.Logger,
    readonly hubPoolClient: HubPoolClient,
    spokePoolClients: SpokePoolClientsByChain,
    readonly enabledChainIds: number[],
    readonly relayerAddress: string,
    readonly defaultMinRelayerFeePct = toBNWei(constants.RELAYER_MIN_FEE_PCT),
    readonly debugProfitability = false,
    protected gasMultiplier = toBNWei(constants.DEFAULT_RELAYER_GAS_MULTIPLIER),
    protected gasPadding = toBNWei(constants.DEFAULT_RELAYER_GAS_PADDING)
  ) {
    // Require 0% <= gasPadding <= 200%
    assert(
      this.gasPadding.gte(bnZero) && this.gasPadding.lte(toBNWei(2)),
      `Gas padding out of range (${this.gasPadding})`
    );
    this.gasPadding = toBNWei("1").add(gasPadding);

    // Require 0% <= gasMultiplier <= 400%
    assert(
      this.gasMultiplier.gte(bnZero) && this.gasMultiplier.lte(toBNWei(4)),
      `Gas multiplier out of range (${this.gasMultiplier})`
    );
    this.priceClient = new PriceClient(logger, [
      new acrossApi.PriceFeed(),
      new coingecko.PriceFeed({ apiKey: process.env.COINGECKO_PRO_API_KEY }),
      new defiLlama.PriceFeed(),
    ]);

    for (const chainId of this.enabledChainIds) {
      this.relayerFeeQueries[chainId] = this.constructRelayerFeeQuery(
        chainId,
        spokePoolClients[chainId].spokePool.provider
      );
    }

    this.isTestnet = this.hubPoolClient.chainId !== CHAIN_IDs.MAINNET;
  }

  resolveGasToken(chainId: number): L1Token {
    const symbol = getNativeTokenSymbol(chainId);
    const token = TOKEN_SYMBOLS_MAP[symbol];
    if (!isDefined(symbol) || !isDefined(token)) {
      throw new Error(`Unable to resolve gas token for chain ID ${chainId}`);
    }

    const { decimals, addresses } = token;
    const address = addresses[1]; // Mainnet tokens are always used for price lookups.

    return { symbol, address, decimals };
  }

  getAllPrices(): { [address: string]: BigNumber } {
    return this.tokenPrices;
  }

  /**
   * Convenience function to resolve a token symbol to its underlying address.
   * @notice In case that an address is supplied, it will simply be returned as-is.
   * @param token Token address or symbol to resolve.
   * @returns Address corresponding to token.
   */
  resolveTokenAddress(token: string): string {
    const address = ethersUtils.isAddress(token) ? token : this.tokenSymbolMap[token];
    assert(isDefined(address), `Unable to resolve address for token ${token}`);
    return address;
  }

  /**
   * Return the cached price for token.
   * @param token Token identifier. May be a token symbol or token address on the HubPool chain.
   * @returns Token token price for token.
   */
  getPriceOfToken(token: string): BigNumber {
    const address = this.resolveTokenAddress(token);
    const price = this.tokenPrices[address];
    if (!isDefined(price)) {
      this.logger.warn({ at: "ProfitClient#getPriceOfToken", message: `Token ${token} not in price list.`, address });
      return bnZero;
    }

    return price;
  }

  // @todo: Factor in the gas cost of submitting the RefundRequest on alt refund chains.
  async getTotalGasCost(deposit: Deposit, fillAmount?: BigNumber): Promise<TransactionCostEstimate> {
    const { destinationChainId: chainId } = deposit;
    fillAmount ??= sdkUtils.getDepositOutputAmount(deposit);

    // If there's no attached message, gas consumption from previous fills can be used in most cases.
    // @todo: Simulate this per-token in future, because some ERC20s consume more gas.
    if (isMessageEmpty(resolveDepositMessage(deposit)) && isDefined(this.totalGasCosts[chainId])) {
      return this.totalGasCosts[chainId];
    }

    const { relayerAddress, relayerFeeQueries } = this;
    try {
      return await relayerFeeQueries[chainId].getGasCosts(deposit, fillAmount, relayerAddress);
    } catch (err) {
      const reason = isEthersError(err) ? err.reason : isError(err) ? err.message : "unknown error";
      this.logger.warn({
        at: "ProfitClient#getTotalGasCost",
        message: "Failed to simulate fill for deposit.",
        reason,
        deposit,
        fillAmount,
      });
      return { nativeGasCost: bnZero, tokenGasCost: bnZero };
    }
  }

  // Estimate the gas cost of filling this relay.
  async estimateFillCost(
    deposit: Deposit,
    fillAmount?: BigNumber
  ): Promise<Pick<FillProfit, "nativeGasCost" | "tokenGasCost" | "gasTokenPriceUsd" | "gasCostUsd">> {
    const { destinationChainId: chainId } = deposit;
    fillAmount ??= sdkUtils.getDepositOutputAmount(deposit);

    const gasToken = this.resolveGasToken(chainId);
    const gasTokenPriceUsd = this.getPriceOfToken(gasToken.symbol);
    let { nativeGasCost, tokenGasCost } = await this.getTotalGasCost(deposit, fillAmount);

    Object.entries({
      "gas consumption": nativeGasCost, // raw gas units
      "gas cost": tokenGasCost, // gas token (i.e. wei)
      "gas token price": gasTokenPriceUsd, // usd/gasToken
    }).forEach(([err, field]) => {
      if (field.lte(bnZero)) {
        throw new Error(`Unable to compute gas cost (${err} unknown)`);
      }
    });

    // Fills with messages have arbitrary execution and therefore lower certainty about the simulated execution cost.
    // Pad these estimates before computing profitability to allow execution headroom and reduce the chance of an OoG.
    nativeGasCost = nativeGasCost.mul(this.gasPadding).div(fixedPoint);
    tokenGasCost = tokenGasCost.mul(this.gasPadding).div(fixedPoint);

    // Gas estimates for token-only fills are stable and reliable. Allow these to be scaled up or down via the
    // configured gasMultiplier. Do not scale the nativeGasCost, since it might be used to set the transaction gasLimit.
    // @todo Consider phasing this out and relying solely on the minimum profitability config.
    if (isMessageEmpty(resolveDepositMessage(deposit))) {
      tokenGasCost = tokenGasCost.mul(this.gasMultiplier).div(fixedPoint);
    }

    const gasCostUsd = tokenGasCost.mul(gasTokenPriceUsd).div(bn10.pow(gasToken.decimals));

    return {
      nativeGasCost,
      tokenGasCost,
      gasTokenPriceUsd,
      gasCostUsd,
    };
  }

  getUnprofitableFills(): { [chainId: number]: UnprofitableFill[] } {
    return this.unprofitableFills;
  }

  clearUnprofitableFills(): void {
    this.unprofitableFills = {};
  }

  // Allow the minimum relayer fee to be overridden per token/route:
  // 0.1bps on USDC from Optimism to Arbitrum:
  //   - MIN_RELAYER_FEE_PCT_USDC_42161_10=0.00001
  minRelayerFeePct(symbol: string, srcChainId: number, dstChainId: number): BigNumber {
    const routeKey = `${symbol}_${srcChainId}_${dstChainId}`;
    let minRelayerFeePct = this.minRelayerFees[routeKey];

    if (!minRelayerFeePct) {
      const _minRelayerFeePct = process.env[`MIN_RELAYER_FEE_PCT_${routeKey}`];
      minRelayerFeePct = _minRelayerFeePct ? toBNWei(_minRelayerFeePct) : this.defaultMinRelayerFeePct;

      // Save the route for next time.
      this.minRelayerFees[routeKey] = minRelayerFeePct;
    }

    return minRelayerFeePct as BigNumber;
  }

  appliedRelayerFeePct(deposit: Deposit): BigNumber {
    // Return the maximum available relayerFeePct (max of Deposit and any SpeedUp).
    return max(deposit.relayerFeePct, deposit.newRelayerFeePct ?? bnZero);
  }

  async calculateFillProfitability(
    deposit: Deposit,
    fillAmount: BigNumber,
    refundFee: BigNumber,
    l1Token: L1Token,
    minRelayerFeePct: BigNumber
  ): Promise<FillProfit> {
    assert(fillAmount.gt(0), `Unexpected fillAmount: ${fillAmount}`);
    const tokenPriceUsd = this.getPriceOfToken(l1Token.symbol);
    if (tokenPriceUsd.lte(0)) {
      throw new Error(`Unable to determine ${l1Token.symbol} L1 token price`);
    }

    // Normalise to 18 decimals.
    const scaledFillAmount = l1Token.decimals === 18 ? fillAmount : fillAmount.mul(toBNWei(1, 18 - l1Token.decimals));
    const scaledRefundFeeAmount =
      l1Token.decimals === 18 ? refundFee : refundFee.mul(toBNWei(1, 18 - l1Token.decimals));

    const grossRelayerFeePct = this.appliedRelayerFeePct(deposit);

    // Calculate relayer fee and capital outlay in relay token terms.
    const grossRelayerFee = grossRelayerFeePct.mul(scaledFillAmount).div(fixedPoint);
    const relayerCapital = scaledFillAmount.sub(grossRelayerFee);

    // Normalise to USD terms.
    const fillAmountUsd = scaledFillAmount.mul(tokenPriceUsd).div(fixedPoint);
    const refundFeeUsd = scaledRefundFeeAmount.mul(tokenPriceUsd).div(fixedPoint);
    const grossRelayerFeeUsd = grossRelayerFee.mul(tokenPriceUsd).div(fixedPoint);
    const relayerCapitalUsd = relayerCapital.mul(tokenPriceUsd).div(fixedPoint);

    // Estimate the gas cost of filling this relay.
    const { nativeGasCost, tokenGasCost, gasTokenPriceUsd, gasCostUsd } = await this.estimateFillCost(
      deposit,
      fillAmount
    );

    // Determine profitability.
    const netRelayerFeeUsd = grossRelayerFeeUsd.sub(gasCostUsd).sub(refundFeeUsd);
    const netRelayerFeePct = netRelayerFeeUsd.mul(fixedPoint).div(relayerCapitalUsd);

    // If token price or gas price is unknown, assume the relay is unprofitable.
    const profitable = tokenPriceUsd.gt(0) && gasTokenPriceUsd.gt(0) && netRelayerFeePct.gte(minRelayerFeePct);

    return {
      grossRelayerFeePct,
      tokenPriceUsd,
      fillAmountUsd,
      grossRelayerFeeUsd,
      nativeGasCost,
      tokenGasCost,
      gasPadding: this.gasPadding,
      gasMultiplier: this.gasMultiplier,
      gasTokenPriceUsd,
      gasCostUsd,
      refundFeeUsd,
      relayerCapitalUsd,
      netRelayerFeePct,
      netRelayerFeeUsd,
      profitable,
    };
  }

  // Return USD amount of fill amount for deposited token, should always return in wei as the units.
  getFillAmountInUsd(deposit: Deposit, fillAmount: BigNumber): BigNumber {
    const l1TokenInfo = this.hubPoolClient.getTokenInfoForDeposit(deposit);
    if (!l1TokenInfo) {
      const inputToken = sdkUtils.getDepositInputToken(deposit);
      throw new Error(
        `ProfitClient::isFillProfitable missing l1TokenInfo for deposit with origin token: ${inputToken}`
      );
    }
    const tokenPriceInUsd = this.getPriceOfToken(l1TokenInfo.symbol);
    return fillAmount.mul(tokenPriceInUsd).div(bn10.pow(l1TokenInfo.decimals));
  }

  async getFillProfitability(
    deposit: Deposit,
    fillAmount: BigNumber,
    refundFee: BigNumber,
    l1Token: L1Token
  ): Promise<FillProfit> {
    const minRelayerFeePct = this.minRelayerFeePct(l1Token.symbol, deposit.originChainId, deposit.destinationChainId);

    const fill = await this.calculateFillProfitability(deposit, fillAmount, refundFee, l1Token, minRelayerFeePct);
    if (!fill.profitable || this.debugProfitability) {
      const { depositId, originChainId } = deposit;
      const profitable = fill.profitable ? "profitable" : "unprofitable";

      this.logger.debug({
        at: "ProfitClient#isFillProfitable",
        message: `${l1Token.symbol} deposit ${depositId} on chain ${originChainId} is ${profitable}`,
        deposit,
        l1Token,
        fillAmount: formatEther(fillAmount),
        fillAmountUsd: formatEther(fill.fillAmountUsd),
        grossRelayerFeePct: `${formatFeePct(fill.grossRelayerFeePct)}%`,
        nativeGasCost: fill.nativeGasCost,
        tokenGasCost: formatEther(fill.tokenGasCost),
        gasPadding: this.gasPadding,
        gasMultiplier: this.gasMultiplier,
        gasTokenPriceUsd: formatEther(fill.gasTokenPriceUsd),
        refundFeeUsd: formatEther(fill.refundFeeUsd),
        relayerCapitalUsd: formatEther(fill.relayerCapitalUsd),
        grossRelayerFeeUsd: formatEther(fill.grossRelayerFeeUsd),
        gasCostUsd: formatEther(fill.gasCostUsd),
        netRelayerFeeUsd: formatEther(fill.netRelayerFeeUsd),
        netRelayerFeePct: `${formatFeePct(fill.netRelayerFeePct)}%`,
        minRelayerFeePct: `${formatFeePct(minRelayerFeePct)}%`,
        profitable: fill.profitable,
      });
    }

    return fill;
  }

  async isFillProfitable(
    deposit: Deposit,
    fillAmount: BigNumber,
    refundFee: BigNumber,
    l1Token: L1Token
  ): Promise<Pick<FillProfit, "profitable" | "nativeGasCost">> {
    let profitable = false;
    let nativeGasCost = uint256Max;
    try {
      ({ profitable, nativeGasCost } = await this.getFillProfitability(deposit, fillAmount, refundFee, l1Token));
    } catch (err) {
      this.logger.debug({
        at: "ProfitClient#isFillProfitable",
        message: `Unable to determine fill profitability (${err}).`,
        deposit,
        fillAmount,
      });
    }

    return {
      profitable: profitable || this.isTestnet,
      nativeGasCost,
    };
  }

  captureUnprofitableFill(deposit: DepositWithBlock, fillAmount: BigNumber, gasCost: BigNumber): void {
    this.logger.debug({ at: "ProfitClient", message: "Handling unprofitable fill", deposit, fillAmount, gasCost });
    assign(this.unprofitableFills, [deposit.originChainId], [{ deposit, fillAmount, gasCost }]);
  }

  anyCapturedUnprofitableFills(): boolean {
    return Object.keys(this.unprofitableFills).length != 0;
  }

  async update(): Promise<void> {
    await Promise.all([this.updateTokenPrices(), this.updateGasCosts()]);
  }

  protected async updateTokenPrices(): Promise<void> {
    // Generate list of tokens to retrieve. Map by symbol because tokens like
    // ETH/WETH refer to the same mainnet contract address.
    const tokens: { [_symbol: string]: string } = Object.fromEntries(
      this.hubPoolClient.getL1Tokens().map(({ symbol }) => {
        const { addresses } = TOKEN_SYMBOLS_MAP[symbol];
        const address = addresses[1];
        return [symbol, address];
      })
    );

    // Also ensure all gas tokens are included in the lookup.
    this.enabledChainIds.forEach((chainId) => {
      const symbol = getNativeTokenSymbol(chainId);
      tokens[symbol] ??= TOKEN_SYMBOLS_MAP[symbol].addresses[1];
    });

    this.logger.debug({ at: "ProfitClient", message: "Updating Profit client", tokens });

    // Pre-populate any new addresses.
    Object.entries(tokens).forEach(([symbol, address]) => {
      this.tokenSymbolMap[symbol] ??= address;
      this.tokenPrices[address] ??= bnZero;
    });

    try {
      const tokenAddrs = Array.from(new Set(Object.values(tokens)));
      const tokenPrices = await this.priceClient.getPricesByAddress(tokenAddrs, "usd");
      tokenPrices.forEach(({ address, price }) => (this.tokenPrices[address] = toBNWei(price)));
      this.logger.debug({ at: "ProfitClient", message: "Updated token prices", tokenPrices: this.tokenPrices });
    } catch (err) {
      const errMsg = `Failed to update token prices (${err})`;
      let mrkdwn = `${errMsg}:\n`;
      Object.entries(tokens).forEach(([symbol, address]) => {
        mrkdwn += `- Using last known ${symbol} price of ${this.getPriceOfToken(address)}.\n`;
      });
      this.logger.warn({ at: "ProfitClient", message: "Could not fetch all token prices 💳", mrkdwn });
      throw new Error(errMsg);
    }
  }

  private async updateGasCosts(): Promise<void> {
    const { enabledChainIds, hubPoolClient, relayerFeeQueries } = this;
    const relayer = this.hubPoolClient.chainId === CHAIN_IDs.MAINNET ? PROD_RELAYER : TEST_RELAYER;
    const depositId = random(uint32Max.toNumber()); // random depositId + "" originToken => ~impossible to collide.
    const fillAmount = bnOne;
    const quoteTimestamp = getCurrentTime();

    // Pre-fetch total gas costs for relays on enabled chains.
    const testSymbol = "WETH";
    const hubToken = TOKEN_SYMBOLS_MAP[testSymbol].addresses[this.hubPoolClient.chainId];
    await sdkUtils.mapAsync(enabledChainIds, async (destinationChainId) => {
      const destinationToken =
        destinationChainId === hubPoolClient.chainId
          ? hubToken
          : hubPoolClient.getL2TokenForL1TokenAtBlock(hubToken, destinationChainId);
      assert(isDefined(destinationToken), `Chain ${destinationChainId} SpokePool is not configured for ${testSymbol}`);

      const deposit: v2Deposit = {
        depositId,
        depositor: TEST_RECIPIENT,
        recipient: TEST_RECIPIENT,
        originToken: "", // Not verified by the SpokePool.
        amount: fillAmount,
        originChainId: destinationChainId, // Not verified by the SpokePool.
        destinationChainId,
        relayerFeePct: bnOne,
        realizedLpFeePct: bnOne,
        destinationToken,
        quoteTimestamp,
        message: EMPTY_MESSAGE,
      };

      // @dev The relayer _cannot_ be the recipient because the SpokePool skips the ERC20 transfer. Instead,
      // use the main RL address because it has all supported tokens and approvals in place on all chains.
      this.totalGasCosts[destinationChainId] = await relayerFeeQueries[destinationChainId].getGasCosts(
        deposit,
        fillAmount,
        relayer
      );
    });

    this.logger.debug({
      at: "ProfitClient",
      message: "Updated gas cost",
      enabledChainIds: this.enabledChainIds,
      totalGasCosts: this.totalGasCosts,
    });
  }

  private constructRelayerFeeQuery(chainId: number, provider: Provider): relayFeeCalculator.QueryInterface {
    // Fallback to Coingecko's free API for now.
    // TODO: Add support for Coingecko Pro.
    const coingeckoProApiKey = undefined;
    // TODO: Set this once we figure out gas markup on the API side.
    const gasMarkup = 0;
    return new QUERY_HANDLERS[chainId](
      provider,
      undefined, // symbolMapping
      undefined, // spokePoolAddress
      undefined, // simulatedRelayerAddress
      coingeckoProApiKey,
      this.logger,
      gasMarkup
    );
  }
}

import { Provider } from "@ethersproject/abstract-provider";
import { utils as ethersUtils } from "ethers";
import {
  constants as sdkConsts,
  priceClient,
  relayFeeCalculator,
  typeguards,
  utils as sdkUtils,
} from "@across-protocol/sdk";
import * as constants from "../common/Constants";
import {
  assert,
  bnOne,
  bnZero,
  bnUint256Max as uint256Max,
  fixedPointAdjustment as fixedPoint,
  BigNumber,
  formatFeePct,
  getCurrentTime,
  isDefined,
  min,
  winston,
  toBNWei,
  toBN,
  assign,
  CHAIN_IDs,
  TOKEN_SYMBOLS_MAP,
  TOKEN_EQUIVALENCE_REMAPPING,
  ZERO_ADDRESS,
} from "../utils";
import {
  Deposit,
  DepositWithBlock,
  L1Token,
  SpokePoolClientsByChain,
  V3Deposit,
  V3DepositWithBlock,
} from "../interfaces";
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
  inputTokenPriceUsd: BigNumber;
  inputAmountUsd: BigNumber;
  outputTokenPriceUsd: BigNumber;
  outputAmountUsd: BigNumber;
  grossRelayerFeePct: BigNumber; // Max of relayerFeePct and newRelayerFeePct from Deposit.
  grossRelayerFeeUsd: BigNumber; // USD value of the relay fee paid by the user.
  nativeGasCost: BigNumber; // Cost of completing the fill in the units of gas.
  tokenGasCost: BigNumber; // Cost of completing the fill in the relevant gas token.
  gasPadding: BigNumber; // Positive padding applied to nativeGasCost and tokenGasCost before profitability.
  gasMultiplier: BigNumber; // Gas multiplier applied to fill cost estimates before profitability.
  gasTokenPriceUsd: BigNumber; // Price paid per unit of gas the gas token in USD.
  gasCostUsd: BigNumber; // Estimated cost of completing the fill in USD.
  netRelayerFeePct: BigNumber; // Relayer fee after gas costs as a portion of relayerCapitalUsd.
  netRelayerFeeUsd: BigNumber; // Relayer fee in USD after paying for gas costs.
  totalFeePct: BigNumber; // Total fee as a portion of the fill amount.
  profitable: boolean; // Fill profitability indicator.
};

type UnprofitableFill = {
  deposit: DepositWithBlock;
  lpFeePct: BigNumber;
  relayerFeePct: BigNumber;
  gasCost: BigNumber;
};

// @dev This address is known on each chain and has previously been used to simulate Deposit gas costs.
// Since _some_ known recipient address is needed for simulating a fill, default to this one. nb. Since
// the SpokePool implements custom behaviour when relayer === recipient, it's important not to use the
// relayer's own address. The specified address is deliberately setup by RL to have a 0 token balance.
const TEST_RECIPIENT = "0xBb23Cd0210F878Ea4CcA50e9dC307fb0Ed65Cf6B";

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
    protected gasMessageMultiplier = toBNWei(constants.DEFAULT_RELAYER_GAS_MESSAGE_MULTIPLIER),
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
    assert(
      this.gasMessageMultiplier.gte(bnZero) && this.gasMessageMultiplier.lte(toBNWei(4)),
      `Gas message multiplier out of range (${this.gasMessageMultiplier})`
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

  resolveGasMultiplier(deposit: Deposit): BigNumber {
    return isMessageEmpty(resolveDepositMessage(deposit)) ? this.gasMultiplier : this.gasMessageMultiplier;
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
    if (ethersUtils.isAddress(token)) {
      return token;
    }
    const remappedTokenSymbol = TOKEN_EQUIVALENCE_REMAPPING[token] ?? token;
    const address = this.tokenSymbolMap[remappedTokenSymbol];
    assert(
      isDefined(address),
      `ProfitClient#resolveTokenAddress: Unable to resolve address for token ${token} (using remapped symbol ${remappedTokenSymbol})`
    );
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

  private async _getTotalGasCost(deposit: V3Deposit, relayer: string): Promise<TransactionCostEstimate> {
    try {
      return await this.relayerFeeQueries[deposit.destinationChainId].getGasCosts(deposit, relayer);
    } catch (err) {
      const reason = isEthersError(err) ? err.reason : isError(err) ? err.message : "unknown error";
      this.logger.warn({
        at: "ProfitClient#getTotalGasCost",
        message: "Failed to simulate fill for deposit.",
        reason,
        deposit,
      });
      return { nativeGasCost: uint256Max, tokenGasCost: uint256Max };
    }
  }

  async getTotalGasCost(deposit: V3Deposit): Promise<TransactionCostEstimate> {
    const { destinationChainId: chainId } = deposit;

    // If there's no attached message, gas consumption from previous fills can be used in most cases.
    // @todo: Simulate this per-token in future, because some ERC20s consume more gas.
    if (isMessageEmpty(resolveDepositMessage(deposit)) && isDefined(this.totalGasCosts[chainId])) {
      return this.totalGasCosts[chainId];
    }

    return this._getTotalGasCost(deposit, this.relayerAddress);
  }

  // Estimate the gas cost of filling this relay.
  async estimateFillCost(
    deposit: V3Deposit
  ): Promise<Pick<FillProfit, "nativeGasCost" | "tokenGasCost" | "gasTokenPriceUsd" | "gasCostUsd">> {
    const { destinationChainId: chainId } = deposit;

    const gasToken = this.resolveGasToken(chainId);
    const gasTokenPriceUsd = this.getPriceOfToken(gasToken.symbol);
    let { nativeGasCost, tokenGasCost } = await this.getTotalGasCost(deposit);

    Object.entries({
      "gas consumption": nativeGasCost, // raw gas units
      "gas cost": tokenGasCost, // gas token (i.e. wei)
      "gas token price": gasTokenPriceUsd, // usd/gasToken
    }).forEach(([err, field]) => {
      if (field.eq(uint256Max) || field.lte(bnZero)) {
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
    const gasMultiplier = this.resolveGasMultiplier(deposit);
    tokenGasCost = tokenGasCost.mul(gasMultiplier).div(fixedPoint);

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

  /**
   * @param deposit V3Deposit object.
   * @param lpFeePct Predetermined LP fee as a multiplier of the deposit inputAmount.
   * @param minRelayerFeePct Relayer minimum fee requirements.
   * @returns FillProfit object detailing the profitability breakdown.
   */
  async calculateFillProfitability(
    deposit: V3Deposit,
    lpFeePct: BigNumber,
    minRelayerFeePct: BigNumber
  ): Promise<FillProfit> {
    const { hubPoolClient } = this;

    const inputTokenInfo = hubPoolClient.getL1TokenInfoForL2Token(deposit.inputToken, deposit.originChainId);
    const inputTokenPriceUsd = this.getPriceOfToken(inputTokenInfo.symbol);
    const inputTokenScalar = toBNWei(1, 18 - inputTokenInfo.decimals);
    const scaledInputAmount = deposit.inputAmount.mul(inputTokenScalar);
    const inputAmountUsd = scaledInputAmount.mul(inputTokenPriceUsd).div(fixedPoint);

    // Unlike the input token, output token is not always resolvable via HubPoolClient since outputToken
    // can be any arbitrary token.
    let outputTokenSymbol: string, outputTokenDecimals: number;
    // If the output token and the input token are equivalent, then we can look up the token info
    // via the HubPoolClient since the output token is mapped via PoolRebalanceRoute to the HubPool.
    // If not, then we should look up outputToken in the TOKEN_SYMBOLS_MAP for the destination chain.
    const matchingTokens =
      TOKEN_SYMBOLS_MAP[inputTokenInfo.symbol]?.addresses[deposit.destinationChainId] === deposit.outputToken;
    if (matchingTokens) {
      ({ symbol: outputTokenSymbol, decimals: outputTokenDecimals } = hubPoolClient.getL1TokenInfoForL2Token(
        deposit.outputToken,
        deposit.destinationChainId
      ));
    } else {
      // This function will throw if the token is not found in the TOKEN_SYMBOLS_MAP for the destination chain.
      ({ symbol: outputTokenSymbol, decimals: outputTokenDecimals } = hubPoolClient.getTokenInfoForAddress(
        deposit.outputToken,
        deposit.destinationChainId
      ));
    }
    const outputTokenPriceUsd = this.getPriceOfToken(outputTokenSymbol);
    const outputTokenScalar = toBNWei(1, 18 - outputTokenDecimals);
    const effectiveOutputAmount = min(deposit.outputAmount, deposit.updatedOutputAmount ?? deposit.outputAmount);
    const scaledOutputAmount = effectiveOutputAmount.mul(outputTokenScalar);
    const outputAmountUsd = scaledOutputAmount.mul(outputTokenPriceUsd).div(fixedPoint);

    const totalFeePct = inputAmountUsd.sub(outputAmountUsd).mul(fixedPoint).div(inputAmountUsd);

    // Normalise token amounts to USD terms.
    const scaledLpFeeAmount = scaledInputAmount.mul(lpFeePct).div(fixedPoint);
    const lpFeeUsd = scaledLpFeeAmount.mul(inputTokenPriceUsd).div(fixedPoint);

    // Infer gross relayer fee (excluding gas cost of fill).
    const grossRelayerFeeUsd = inputAmountUsd.sub(outputAmountUsd).sub(lpFeeUsd);
    const grossRelayerFeePct = grossRelayerFeeUsd.gt(bnZero)
      ? grossRelayerFeeUsd.mul(fixedPoint).div(inputAmountUsd)
      : bnZero;

    // Estimate the gas cost of filling this relay.
    const { nativeGasCost, tokenGasCost, gasTokenPriceUsd, gasCostUsd } = await this.estimateFillCost(deposit);

    // Determine profitability. netRelayerFeePct effectively represents the capital cost to the relayer;
    // i.e. how much it pays out to the recipient vs. the net fee that it receives for doing so.
    const netRelayerFeeUsd = grossRelayerFeeUsd.sub(gasCostUsd);
    const netRelayerFeePct = outputAmountUsd.gt(bnZero)
      ? netRelayerFeeUsd.mul(fixedPoint).div(outputAmountUsd)
      : bnZero;

    // If either token prices are unknown, assume the relay is unprofitable.
    const profitable =
      inputTokenPriceUsd.gt(bnZero) && outputTokenPriceUsd.gt(bnZero) && netRelayerFeePct.gte(minRelayerFeePct);

    return {
      totalFeePct,
      inputTokenPriceUsd,
      inputAmountUsd,
      outputTokenPriceUsd,
      outputAmountUsd,
      grossRelayerFeePct,
      grossRelayerFeeUsd,
      nativeGasCost,
      tokenGasCost,
      gasPadding: this.gasPadding,
      gasMultiplier: this.resolveGasMultiplier(deposit),
      gasTokenPriceUsd,
      gasCostUsd,
      netRelayerFeePct,
      netRelayerFeeUsd,
      profitable,
    };
  }

  // Return USD amount of fill amount for deposited token, should always return in wei as the units.
  getFillAmountInUsd(deposit: Deposit, fillAmount = deposit.outputAmount): BigNumber {
    const l1TokenInfo = this.hubPoolClient.getTokenInfoForDeposit(deposit);
    if (!l1TokenInfo) {
      const { inputToken } = deposit;
      throw new Error(
        `ProfitClient#getFillAmountInUsd missing l1TokenInfo for deposit with origin token: ${inputToken}`
      );
    }
    const tokenPriceInUsd = this.getPriceOfToken(l1TokenInfo.symbol);
    return fillAmount.mul(tokenPriceInUsd).div(bn10.pow(l1TokenInfo.decimals));
  }

  async getFillProfitability(
    deposit: V3Deposit,
    lpFeePct: BigNumber,
    l1Token: L1Token,
    repaymentChainId: number
  ): Promise<FillProfit> {
    const minRelayerFeePct = this.minRelayerFeePct(l1Token.symbol, deposit.originChainId, deposit.destinationChainId);

    const fill = await this.calculateFillProfitability(deposit, lpFeePct, minRelayerFeePct);
    if (!fill.profitable || this.debugProfitability) {
      const { depositId } = deposit;
      const profitable = fill.profitable ? "profitable" : "unprofitable";

      this.logger.debug({
        at: "ProfitClient#getFillProfitability",
        message: `${l1Token.symbol} v3 deposit ${depositId} with repayment on ${repaymentChainId} is ${profitable}`,
        deposit,
        inputTokenPriceUsd: formatEther(fill.inputTokenPriceUsd),
        inputTokenAmountUsd: formatEther(fill.inputAmountUsd),
        outputTokenPriceUsd: formatEther(fill.inputTokenPriceUsd),
        outputTokenAmountUsd: formatEther(fill.outputAmountUsd),
        totalFeePct: `${formatFeePct(fill.totalFeePct)}%`,
        lpFeePct: `${formatFeePct(lpFeePct)}%`,
        grossRelayerFeePct: `${formatFeePct(fill.grossRelayerFeePct)}%`,
        nativeGasCost: fill.nativeGasCost,
        tokenGasCost: formatEther(fill.tokenGasCost),
        gasPadding: this.gasPadding,
        gasMultiplier: formatEther(this.resolveGasMultiplier(deposit)),
        gasTokenPriceUsd: formatEther(fill.gasTokenPriceUsd),
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
    deposit: V3Deposit,
    lpFeePct: BigNumber,
    l1Token: L1Token,
    repaymentChainId: number
  ): Promise<Pick<FillProfit, "profitable" | "nativeGasCost" | "tokenGasCost" | "netRelayerFeePct">> {
    let profitable = false;
    let netRelayerFeePct = bnZero;
    let nativeGasCost = uint256Max;
    let tokenGasCost = uint256Max;
    try {
      ({ profitable, netRelayerFeePct, nativeGasCost, tokenGasCost } = await this.getFillProfitability(
        deposit,
        lpFeePct,
        l1Token,
        repaymentChainId
      ));
    } catch (err) {
      this.logger.debug({
        at: "ProfitClient#isFillProfitable",
        message: `Unable to determine fill profitability (${err}).`,
        deposit,
        lpFeePct,
      });
    }

    return {
      profitable: profitable || (this.isTestnet && nativeGasCost.lt(uint256Max)),
      nativeGasCost,
      tokenGasCost,
      netRelayerFeePct,
    };
  }

  captureUnprofitableFill(
    deposit: V3DepositWithBlock,
    lpFeePct: BigNumber,
    relayerFeePct: BigNumber,
    gasCost: BigNumber
  ): void {
    this.logger.debug({
      at: "ProfitClient",
      message: "Handling unprofitable fill",
      deposit,
      lpFeePct,
      relayerFeePct,
      gasCost,
    });
    assign(this.unprofitableFills, [deposit.originChainId], [{ deposit, lpFeePct, relayerFeePct, gasCost }]);
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
      this.hubPoolClient
        .getL1Tokens()
        .filter(({ symbol }) => isDefined(TOKEN_SYMBOLS_MAP[symbol]))
        .map(({ symbol }) => {
          const { addresses } = TOKEN_SYMBOLS_MAP[symbol];
          const address = addresses[1];
          return [symbol, address];
        })
    );

    // Log any tokens that are in the L1Tokens list but are not in the tokenSymbolsMap.
    // Note: we should batch these up and log them all at once to avoid spamming the logs.
    const unknownTokens = this.hubPoolClient
      .getL1Tokens()
      .filter(({ symbol }) => !isDefined(TOKEN_SYMBOLS_MAP[symbol]));
    if (unknownTokens.length > 0) {
      this.logger.debug({
        at: "ProfitClient#updateTokenPrices",
        message: "Filtered out unknown token(s) that don't have a corresponding entry in TOKEN_SYMBOLS_MAP.",
        unknownTokens,
        resolvedTokens: Object.keys(tokens),
        availableTokens: Object.keys(TOKEN_SYMBOLS_MAP),
      });
    }

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
    const { enabledChainIds, hubPoolClient } = this;
    const outputAmount = toBN(100); // Avoid rounding to zero but ensure the relayer has sufficient balance to estimate.
    const currentTime = getCurrentTime();

    // Prefer USDC on mainnet because it's consistent in terms of gas estimation (no unwrap conditional).
    // Prefer WETH on testnet because it's more likely to be configured for the destination SpokePool.
    // The relayer _cannot_ be the recipient because the SpokePool skips the ERC20 transfer. Instead, use
    // the main RL address because it has all supported tokens and approvals in place on all chains.
    const testSymbols = {
      [CHAIN_IDs.LISK]: "USDT", // USDC is not yet supported on Lisk, so revert to USDT. @todo: Update.
    };
    const [defaultTestSymbol, relayer] =
      this.hubPoolClient.chainId === CHAIN_IDs.MAINNET ? ["USDC", PROD_RELAYER] : ["WETH", TEST_RELAYER];

    // @dev The relayer _cannot_ be the recipient because the SpokePool skips the ERC20 transfer. Instead,
    // use the main RL address because it has all supported tokens and approvals in place on all chains.
    const sampleDeposit = {
      depositId: 0,
      depositor: TEST_RECIPIENT,
      recipient: TEST_RECIPIENT,
      inputToken: ZERO_ADDRESS, // Not verified by the SpokePool.
      inputAmount: outputAmount.add(bnOne),
      outputToken: "", // SpokePool-specific, overwritten later.
      outputAmount,
      originChainId: 0, // Not verified by the SpokePool.
      destinationChainId: 0, // SpokePool-specific, overwritten later.
      quoteTimestamp: currentTime - 60,
      fillDeadline: currentTime + 60,
      exclusivityDeadline: 0,
      exclusiveRelayer: ZERO_ADDRESS,
      message: EMPTY_MESSAGE,
      fromLiteChain: false,
      toLiteChain: false,
    };

    // Pre-fetch total gas costs for relays on enabled chains.
    await sdkUtils.mapAsync(enabledChainIds, async (destinationChainId) => {
      const symbol = testSymbols[destinationChainId] ?? defaultTestSymbol;
      const hubToken = TOKEN_SYMBOLS_MAP[symbol].addresses[this.hubPoolClient.chainId];
      const outputToken =
        destinationChainId === hubPoolClient.chainId
          ? hubToken
          : hubPoolClient.getL2TokenForL1TokenAtBlock(hubToken, destinationChainId);
      assert(isDefined(outputToken), `Chain ${destinationChainId} SpokePool is not configured for ${symbol}`);

      const deposit = { ...sampleDeposit, destinationChainId, outputToken };
      this.totalGasCosts[destinationChainId] = await this._getTotalGasCost(deposit, relayer);
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
    // Call the factory to create a new QueryBase instance.
    return relayFeeCalculator.QueryBase__factory.create(
      chainId,
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

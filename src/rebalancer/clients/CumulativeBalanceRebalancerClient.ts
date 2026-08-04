import {
  assert,
  acrossApi,
  BigNumber,
  bnZero,
  coingecko,
  ConvertDecimals,
  defiLlama,
  fromWei,
  getNetworkName,
  getTokenInfoFromSymbol,
  isDefined,
  mapAsync,
  PriceClient,
  toBNWei,
} from "../../utils";
import { ExcessOrDeficit } from "../utils/interfaces";
import { sortDeficitFunction, sortExcessFunction } from "../utils/utils";
import { BaseRebalancerClient } from "./BaseRebalancerClient";
import { getAcrossHost } from "../../clients/AcrossAPIClient";

export class CumulativeBalanceRebalancerClient extends BaseRebalancerClient {
  private readonly priceClient: PriceClient;
  private readonly tokenPriceCache = new Map<string, BigNumber>();

  constructor(...args: ConstructorParameters<typeof BaseRebalancerClient>) {
    super(...args);
    this.priceClient = new PriceClient(this.logger, [
      new acrossApi.PriceFeed({ host: getAcrossHost(this.config.hubPoolChainId) }),
      new coingecko.PriceFeed({ apiKey: process.env.COINGECKO_PRO_API_KEY }),
      new defiLlama.PriceFeed(),
    ]);
  }

  /**
   * @notice Rebalances cumulative balances of tokens across chains where cumulative token balances are above
   * configured targets to tokens that have cumulative balances below configured thresholds. Tokens are sourced
   * from chains sorted by configured priority tier and current balance level.
   * @param cumulativeBalances Dictionary of token -> cumulative virtual balances.
   * @param currentBalancesOnChain Dictionary of chainId -> token -> current on-chain balance.
   * @param maxFeePct Maximum fee percentage to allow for rebalances.
   */
  override async rebalanceInventory(
    cumulativeBalances: { [token: string]: BigNumber },
    currentBalancesOnChain: { [chainId: number]: { [token: string]: BigNumber } },
    maxFeePct: BigNumber
  ): Promise<void> {
    // Assert invariants:

    // - Assert that each target balance has a corresponding cumulative balance.
    const cumulativeTargetBalances = this.config.cumulativeTargetBalances;
    for (const [sourceToken] of Object.entries(cumulativeTargetBalances)) {
      assert(
        isDefined(cumulativeBalances[sourceToken]),
        `RebalanceClient#rebalanceCumulativeInventory: Undefined cumulative balance for ${sourceToken} on which has a target balance`
      );
    }

    // - Pick the list of available rebalance routes as those that connect tokens that are configured in current balances
    // and the cumulative rebalance chain list.
    const availableRebalanceRoutes = this.rebalanceRoutes.filter((route) => {
      return (
        isDefined(currentBalancesOnChain[route.sourceChain]?.[route.sourceToken]) &&
        isDefined(currentBalancesOnChain[route.destinationChain]?.[route.destinationToken]) &&
        isDefined(cumulativeTargetBalances[route.sourceToken]?.chains?.[route.sourceChain]) &&
        isDefined(cumulativeTargetBalances[route.destinationToken]?.chains?.[route.destinationChain])
      );
    });

    this.logger.debug({
      at: "CumulativeBalanceRebalancerClient.rebalanceInventory",
      message: "Available rebalance routes",
      currentBalancesOnChain: Object.entries(currentBalancesOnChain).map(([chainId, tokens]) => {
        return {
          [chainId]: Object.fromEntries(
            Object.entries(tokens).map(([token, balance]) => {
              return [token, balance.toString()];
            })
          ),
        };
      }),
      cumulativeBalances: Object.entries(cumulativeBalances).map(([token, balance]) => {
        return {
          [token]: balance.toString(),
        };
      }),
      cumulativeTargetBalances: Object.entries(cumulativeTargetBalances).map(([token, tokenConfig]) => {
        return {
          [token]: tokenConfig.targetBalance.toString(),
        };
      }),
      cumulativeThresholdBalances: Object.entries(cumulativeTargetBalances).map(([token, tokenConfig]) => {
        return {
          [token]: tokenConfig.thresholdBalance.toString(),
        };
      }),
      availableRebalanceRoutes: availableRebalanceRoutes.map(
        (route) =>
          `(${route.adapter}) [${getNetworkName(route.sourceChain)}] ${route.sourceToken} -> [${getNetworkName(
            route.destinationChain
          )}] ${route.destinationToken}`
      ),
    });

    const sortedDeficits: ExcessOrDeficit[] = [];
    const sortedExcesses: ExcessOrDeficit[] = [];
    const tokenPricesUsd = new Map<string, BigNumber>();
    for (const [token, cumulativeBalance] of Object.entries(cumulativeBalances)) {
      // If current balance is below threshold, we want to refill back to target balance.
      const { targetBalance, thresholdBalance, priorityTier } = cumulativeTargetBalances[token];
      const currentCumulativeBalance = cumulativeBalances[token];
      if (currentCumulativeBalance.lt(thresholdBalance)) {
        const deficitAmount = targetBalance.sub(cumulativeBalance);
        sortedDeficits.push({ token, amount: deficitAmount, chainId: this.config.hubPoolChainId, priorityTier });
        tokenPricesUsd.set(token, await this._getTokenPriceUsd(token));
      } else if (currentCumulativeBalance.gt(targetBalance)) {
        const excessAmount = currentCumulativeBalance.sub(targetBalance);
        sortedExcesses.push({ token, amount: excessAmount, chainId: this.config.hubPoolChainId, priorityTier });
        tokenPricesUsd.set(token, await this._getTokenPriceUsd(token));
      }
    }
    sortedDeficits.sort((deficitA, deficitB) => sortDeficitFunction(deficitA, deficitB, tokenPricesUsd));
    if (sortedDeficits.length > 0) {
      this.logger.debug({
        at: "CumulativeBalanceRebalancerClient.rebalanceInventory",
        message: "Sorted deficits",
        deficits: sortedDeficits.map(
          (e) =>
            `${e.token} - ${e.amount.toString()} (priority tier: ${cumulativeTargetBalances[e.token].priorityTier})`
        ),
      });
    }
    // Sort excesses by priority from lowest to highest and then by size from largest to smallest.
    sortedExcesses.sort((excessA, excessB) => sortExcessFunction(excessA, excessB, tokenPricesUsd));
    if (sortedExcesses.length > 0) {
      this.logger.debug({
        at: "CumulativeBalanceRebalancerClient.rebalanceInventory",
        message: "Sorted excesses",
        excesses: sortedExcesses.map(
          (e) =>
            `${e.token} - ${e.amount.toString()} (priority tier: ${cumulativeTargetBalances[e.token].priorityTier})`
        ),
      });
    }

    const startingExcesses = Object.fromEntries(sortedExcesses.map(({ token, amount }) => [token, amount]));

    // Iterate through the sorted deficits and try to fill as much of it as possible from the configured
    // excess token chain list.
    for (const deficit of sortedDeficits) {
      const { token: deficitToken, amount: deficitAmount } = deficit;
      // Keep track of how much of the deficit we need to fill and also how much excess we have available to send.
      let deficitRemaining = deficitAmount;
      for (const excess of sortedExcesses) {
        const excessToken = excess.token;
        let excessRemaining = startingExcesses[excess.token];

        // Sort all the chains with excess tokens by priority from lowest to highest and then by current balance from highest to lowest.
        const excessSourceChainsForToken: ExcessOrDeficit[] = Object.entries(
          cumulativeTargetBalances[excessToken].chains
        )
          .map(([chainId, x]) => [Number(chainId), x])
          .filter(([chainId]) => isDefined(currentBalancesOnChain[chainId]?.[excessToken]))
          .map(([chainId, priorityTier]) => {
            return {
              chainId,
              priorityTier,
              amount: currentBalancesOnChain[chainId][excessToken],
              token: excessToken,
            };
          });
        const sortedExcessSourceChainsForToken = excessSourceChainsForToken.sort(sortExcessFunction);
        this.logger.debug({
          at: "CumulativeBalanceRebalancerClient.rebalanceInventory",
          message: `Sorted excess source chains for token ${excessToken} we can use to fill the deficit of ${deficitToken}`,
          excessSourceChainsForToken: sortedExcessSourceChainsForToken.map(({ chainId, amount }) => {
            return {
              [chainId]: amount.toString(),
            };
          }),
        });

        // Iterate through potential excess source chains and remove any that don't have rebalance routes or have
        // fees that exceed the max fee percentage.
        for (const chainWithExcess of sortedExcessSourceChainsForToken) {
          const { chainId, amount: currentBalance } = chainWithExcess;
          // Invariants: If excess or deficit is depleted, exit.
          if (deficitRemaining.lte(1) || excessRemaining.lte(1)) {
            break;
          }

          const availableAdapters = await this.getAvailableAdapters();
          if (availableAdapters.length === 0) {
            // We break here rather than continue because we assume that pending orders cannot progress while we're
            // in this function.
            this.logger.debug({
              at: "CumulativeBalanceRebalancerClient.rebalanceInventory",
              message: "No more available adapters to fill deficits",
            });
            break;
          }

          const l1TokenDecimals = getTokenInfoFromSymbol(excessToken, this.config.hubPoolChainId).decimals;
          const chainDecimals = getTokenInfoFromSymbol(excessToken, Number(chainId)).decimals;
          const l1ToChainConverter = ConvertDecimals(l1TokenDecimals, chainDecimals);
          const excessRemainingConverted = l1ToChainConverter(excessRemaining);
          const deficitRemainingInExcessToken = await this._convertL1TokenAmountForComparison(
            deficitRemaining,
            deficitToken,
            excessToken
          );
          const deficitRemainingConverted = l1ToChainConverter(deficitRemainingInExcessToken);
          // The max we can transfer is the minimum of {the remaining deficit, the remaining excess, the max amount to transfer, the current balance}
          const maxAmountToTransfer = this.config.maxAmountsToTransfer[excessToken]?.[chainId];
          let amountToTransferCapped =
            isDefined(maxAmountToTransfer) && currentBalance.gt(maxAmountToTransfer)
              ? maxAmountToTransfer
              : currentBalance;
          amountToTransferCapped = amountToTransferCapped.gt(deficitRemainingConverted)
            ? deficitRemainingConverted
            : amountToTransferCapped;
          amountToTransferCapped = amountToTransferCapped.gt(excessRemainingConverted)
            ? excessRemainingConverted
            : amountToTransferCapped;
          if (amountToTransferCapped.lte(bnZero)) {
            continue;
          }

          // To determine which destination chain to receive the deficit token on, we check the estimated cost
          // for all possible destination chains and then select the highest priority chain with the lowest
          // estimated cost.
          const allDestinationChains = cumulativeTargetBalances[deficitToken].chains;
          const rebalanceRoutesToEvaluate = availableRebalanceRoutes.filter(
            (route) =>
              availableAdapters.includes(route.adapter) &&
              route.sourceChain === Number(chainId) &&
              route.sourceToken === excessToken &&
              route.destinationToken === deficitToken &&
              isDefined(allDestinationChains[route.destinationChain])
          );

          if (rebalanceRoutesToEvaluate.length === 0) {
            this.logger.debug({
              at: "CumulativeBalanceRebalancerClient.rebalanceInventory",
              message: `No rebalance routes found for ${excessToken} from ${getNetworkName(chainId)}`,
              originChain: chainId,
              allDestinationChains,
              excessToken,
              deficitToken,
              amountToTransferCapped: amountToTransferCapped.toString(),
            });
            continue;
          }
          const rebalanceRoutesWithCosts = await mapAsync(rebalanceRoutesToEvaluate, async (route) => {
            return {
              route,
              priorityTier: allDestinationChains[route.destinationChain],
              cost: await this.adapters[route.adapter].getEstimatedCost(
                route,
                amountToTransferCapped,
                false /* debugLog set to false because the logs would be really noisy, though detailed about how each estimated cost was computed */
              ),
            };
          });
          rebalanceRoutesWithCosts.sort((a, b) => {
            const sortedPriorityTier = b.priorityTier - a.priorityTier;
            if (sortedPriorityTier !== 0) {
              return sortedPriorityTier;
            }
            if (a.cost.eq(b.cost)) {
              return 0;
            }
            return a.cost.lt(b.cost) ? -1 : 1;
          });
          // Select ranked routes under the max fee guard:
          const maxFee = amountToTransferCapped.mul(maxFeePct).div(toBNWei(100));
          const candidateRoutes = rebalanceRoutesWithCosts.filter(({ cost }) => cost.lte(maxFee));
          if (candidateRoutes.length === 0) {
            this.logger.debug({
              at: "CumulativeBalanceRebalancerClient.rebalanceInventory",
              message: `No route found under max fee of ${maxFee.toString()}`,
            });
            continue;
          }
          this.logger.debug({
            at: "RebalanceClient.rebalanceCumulativeInventory",
            message: `Evaluating sending of ${amountToTransferCapped.toString()} of ${excessToken} from ${getNetworkName(
              chainId
            )}`,
            sortedDestinationChains: allDestinationChains,
            currentBalance: currentBalance.toString(),
            deficitRemaining: deficitRemaining.toString(),
            excessRemaining: excessRemaining.toString(),
            deficitRemainingConvertedToExcessToken: deficitRemainingConverted.toString(),
            maxAmountToTransfer: maxAmountToTransfer?.toString(),
            rebalanceRouteCosts: rebalanceRoutesWithCosts.map(({ route, cost, priorityTier }) => {
              return {
                [route.adapter]: `[P${priorityTier}] ${route.sourceToken} on ${getNetworkName(route.sourceChain)} -> ${
                  route.destinationToken
                } on ${getNetworkName(route.destinationChain)}: ${cost.toString()}`,
              };
            }),
          });

          const chainToL1Converter = ConvertDecimals(chainDecimals, l1TokenDecimals);
          const amountTransferredL1 = chainToL1Converter(amountToTransferCapped);
          const deficitReduction = await this._convertL1TokenAmountForComparison(
            amountTransferredL1,
            excessToken,
            deficitToken
          );
          const nextDeficitRemaining = deficitReduction.gte(deficitRemaining)
            ? bnZero
            : deficitRemaining.sub(deficitReduction);
          const nextExcessRemaining = excessRemaining.sub(amountTransferredL1);
          const nextSourceBalance = currentBalance.sub(amountToTransferCapped);
          for (const chosenRoute of candidateRoutes) {
            this.logger.debug({
              at: "RebalanceClient.rebalanceCumulativeInventory",
              message: `Initializing new ${chosenRoute.route.adapter} ${fromWei(amountToTransferCapped, chainDecimals)} ${excessToken} rebalance from ${getNetworkName(chosenRoute.route.sourceChain)} to ${getNetworkName(chosenRoute.route.destinationChain)} ${deficitToken}`,
              adapter: chosenRoute.route.adapter,
              expectedFees: fromWei(chosenRoute.cost, chainDecimals),
            });

            if (this.config.sendingTransactionsEnabled) {
              const initializedAmount = await this.adapters[chosenRoute.route.adapter].initializeRebalance(
                chosenRoute.route,
                amountToTransferCapped
              );
              if (initializedAmount.eq(bnZero)) {
                this.logger.debug({
                  at: "CumulativeBalanceRebalancerClient.rebalanceInventory",
                  message: `Adapter ${chosenRoute.route.adapter} declined to initialize rebalance; trying next route`,
                  route: chosenRoute.route,
                  requestedAmountToTransfer: amountToTransferCapped.toString(),
                });
                continue;
              }
            }

            // Decrement the deficit remaining, the excess remaining for this token, and the current balance for this
            // token only after the adapter successfully initializes the rebalance.
            deficitRemaining = nextDeficitRemaining;
            excessRemaining = nextExcessRemaining;
            currentBalancesOnChain[chosenRoute.route.sourceChain][excessToken] = nextSourceBalance;
            break;
          }
        }

        // Overwrite the excess remaining for the token to decrement the excess for the next deficit to evaluate.
        startingExcesses[excessToken] = excessRemaining;
      }
    }
  }

  private async _convertL1TokenAmountForComparison(
    amount: BigNumber,
    fromToken: string,
    toToken: string
  ): Promise<BigNumber> {
    if (fromToken === toToken) {
      return amount;
    }

    const fromTokenDecimals = getTokenInfoFromSymbol(fromToken, this.config.hubPoolChainId).decimals;
    const toTokenDecimals = getTokenInfoFromSymbol(toToken, this.config.hubPoolChainId).decimals;

    const [fromPriceUsd, toPriceUsd] = await Promise.all([
      this._getTokenPriceUsd(fromToken),
      this._getTokenPriceUsd(toToken),
    ]);
    const fromTokenUnit = toBNWei("1", fromTokenDecimals);
    const toTokenUnit = toBNWei("1", toTokenDecimals);
    const usdValue = amount.mul(fromPriceUsd).div(fromTokenUnit);
    return usdValue.mul(toTokenUnit).div(toPriceUsd);
  }

  private async _getTokenPriceUsd(token: string): Promise<BigNumber> {
    // Assume that this client is never run in long lasting operations so we are safe to cache this price once
    // per run.
    const cachedPrice = this.tokenPriceCache.get(token);
    if (cachedPrice) {
      return cachedPrice;
    }

    const hubTokenAddress = getTokenInfoFromSymbol(token, this.config.hubPoolChainId).address.toNative();
    const fixedPriceEnv = process.env[`RELAYER_TOKEN_PRICE_FIXED_${hubTokenAddress}`];
    const priceUsd = isDefined(fixedPriceEnv)
      ? toBNWei(fixedPriceEnv)
      : toBNWei((await this.priceClient.getPriceByAddress(hubTokenAddress)).price);
    assert(priceUsd.gt(bnZero), `Unable to resolve positive USD price for ${token}`);
    this.tokenPriceCache.set(token, priceUsd);
    return priceUsd;
  }
}

import {
  assert,
  BigNumber,
  bnZero,
  ConvertDecimals,
  getNetworkName,
  getTokenInfoFromSymbol,
  isDefined,
  mapAsync,
  toBNWei,
} from "../../utils";
import { ExcessOrDeficit, RebalanceRoute } from "../utils/interfaces";
import { sortDeficitFunction, sortExcessFunction } from "../utils/utils";
import { BaseRebalancerClient } from "./BaseRebalancerClient";

export class CumulativeBalanceRebalancerClient extends BaseRebalancerClient {
  /**
   * @notice Rebalances cumulative balances of tokens across chains where cumulative token balances are above
   * configured targets to to tokens that have cumulative balances below configured thresholds. Tokens are sourced
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
      availableRebalanceRoutes: availableRebalanceRoutes.map(
        (route) =>
          `(${route.adapter}) [${getNetworkName(route.sourceChain)}] ${route.sourceToken} -> [${getNetworkName(
            route.destinationChain
          )}] ${route.destinationToken}`
      ),
    });

    // Identify all tokens with cumulative balance deficits and sort them by size, assuming that 1 unit of each token
    // is worth the same amount of USD. Deficits are ranked from most negative to least.
    // @todo We would need to change this logic if we accept the user setting targets for tokens that are not all
    // stablecoins.
    const sortedDeficits: ExcessOrDeficit[] = [];
    const sortedExcesses: ExcessOrDeficit[] = [];
    for (const [token, cumulativeBalance] of Object.entries(cumulativeBalances)) {
      // If current balance is below threshold, we want to refill back to target balance.
      const { targetBalance, thresholdBalance, priorityTier } = cumulativeTargetBalances[token];
      const currentCumulativeBalance = cumulativeBalances[token];
      if (currentCumulativeBalance.lt(thresholdBalance)) {
        const deficitAmount = targetBalance.sub(cumulativeBalance);
        sortedDeficits.push({ token, amount: deficitAmount, chainId: this.config.hubPoolChainId, priorityTier });
      } else if (currentCumulativeBalance.gt(targetBalance)) {
        const excessAmount = currentCumulativeBalance.sub(targetBalance);
        sortedExcesses.push({ token, amount: excessAmount, chainId: this.config.hubPoolChainId, priorityTier });
      }
    }
    // Sort deficits by priority from highest to lowest and then by size from largest to smallest.
    sortedDeficits.sort(sortDeficitFunction);
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
    sortedExcesses.sort(sortExcessFunction);
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

    // Iterate through the sorted deficits and try to fill as much of it as possible from the configured
    // excess token chain list.
    for (const deficit of sortedDeficits) {
      const { token: deficitToken, amount: deficitAmount } = deficit;
      // Keep track of how much of the deficit we need to fill and also how much excess we have available to send.
      let deficitRemaining = deficitAmount;
      for (const excess of sortedExcesses) {
        const { token: excessToken, amount: excessAmount } = excess;
        let excessRemaining = excessAmount;

        // Sort all the chains with excess tokens by priority from lowest to highest and then by current balance from highest to lowest.
        const excessSourceChainsForToken: ExcessOrDeficit[] = Object.entries(
          cumulativeTargetBalances[excessToken].chains
        )
          .filter(([chainId]) => {
            return isDefined(currentBalancesOnChain[chainId]?.[excessToken]);
          })
          .map(([chainId, priorityTier]) => {
            return {
              chainId: Number(chainId),
              priorityTier,
              amount: currentBalancesOnChain[chainId][excessToken],
              token: excessToken,
            };
          });
        const sortedExcessSourceChainsForToken = excessSourceChainsForToken.sort(sortExcessFunction);
        this.logger.debug({
          at: "CumulativeBalanceRebalancerClient.rebalanceInventory",
          message: `Sorted excess source chains for token ${excessToken}`,
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
          if (deficitRemaining.lte(bnZero) || excessRemaining.lte(bnZero)) {
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
          const deficitRemainingConverted = l1ToChainConverter(deficitRemaining);
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

          // To determine which destination chain to receive the deficit token on, we check the estimated cost
          // for all possible destination chains and then select the chain with the lowest estimated cost.
          const allDestinationChains = Object.entries(cumulativeTargetBalances[deficitToken].chains).map(([chainId]) =>
            Number(chainId)
          );
          const rebalanceRoutesToEvaluate: RebalanceRoute[] = [];
          for (const route of availableRebalanceRoutes) {
            allDestinationChains.forEach((destinationChain) => {
              if (
                availableAdapters.includes(route.adapter) &&
                route.sourceChain === Number(chainId) &&
                route.sourceToken === excessToken &&
                route.destinationChain === destinationChain &&
                route.destinationToken === deficitToken
              ) {
                rebalanceRoutesToEvaluate.push(route);
              }
            });
          }

          if (rebalanceRoutesToEvaluate.length === 0) {
            this.logger.debug({
              at: "CumulativeBalanceRebalancerClient.rebalanceInventory",
              message: `No rebalance routes found for ${excessToken} on ${getNetworkName(chainId)}`,
              originChain: chainId,
              allDestinationChains,
              excessToken,
              deficitToken,
              amountToTransferCapped: amountToTransferCapped.toString(),
            });
            continue;
          }
          const rebalanceRouteCosts = await mapAsync(rebalanceRoutesToEvaluate, async (route) => {
            return {
              route,
              cost: await this.adapters[route.adapter].getEstimatedCost(
                route,
                amountToTransferCapped,
                false /* debugLog set to false because the logs would be really noisy, though detailed about how each estimated cost was computed */
              ),
            };
          });
          rebalanceRouteCosts.sort((a, b) => {
            if (a.cost.eq(b.cost)) {
              return 0;
            }
            return a.cost.lt(b.cost) ? -1 : 1;
          });
          const cheapestCostRoute = rebalanceRouteCosts[0];
          this.logger.debug({
            at: "RebalanceClient.rebalanceCumulativeInventory",
            message: `Evaluating sending of ${amountToTransferCapped.toString()} of ${excessToken} on ${getNetworkName(
              chainId
            )}`,
            sortedDestinationChains: allDestinationChains,
            currentBalance: currentBalance.toString(),
            deficitRemaining: deficitRemaining.toString(),
            excessRemaining: excessRemaining.toString(),
            maxAmountToTransfer: maxAmountToTransfer?.toString(),
            cheapestCostRoute: `[${cheapestCostRoute.route.adapter}] ${getNetworkName(
              cheapestCostRoute.route.sourceChain
            )} ${cheapestCostRoute.route.sourceToken} -> ${getNetworkName(cheapestCostRoute.route.destinationChain)} ${
              cheapestCostRoute.route.destinationToken
            }: ${cheapestCostRoute.cost.toString()}`,
            rebalanceRouteCosts: rebalanceRouteCosts.map(({ route, cost }) => {
              return {
                [route.adapter]: `${route.sourceToken} on ${getNetworkName(route.sourceChain)} -> ${
                  route.destinationToken
                } on ${getNetworkName(route.destinationChain)}: ${cost.toString()}`,
              };
            }),
          });

          const maxFee = amountToTransferCapped.mul(maxFeePct).div(toBNWei(100));
          if (cheapestCostRoute.cost.gt(maxFee)) {
            this.logger.debug({
              at: "CumulativeBalanceRebalancerClient.rebalanceInventory",
              message: `Cheapest expected cost ${cheapestCostRoute.cost.toString()} is greater than max fee ${maxFee.toString()}, exiting`,
            });
            continue;
          }

          // Initiate a new rebalance
          const chainToL1Converter = ConvertDecimals(chainDecimals, l1TokenDecimals);
          deficitRemaining = deficitRemaining.sub(chainToL1Converter(amountToTransferCapped));
          excessRemaining = excessRemaining.sub(chainToL1Converter(amountToTransferCapped));
          this.logger.debug({
            at: "RebalanceClient.rebalanceCumulativeInventory",
            message: `Initializing new ${cheapestCostRoute.route.adapter} rebalance from ${
              cheapestCostRoute.route.sourceToken
            } on ${getNetworkName(cheapestCostRoute.route.sourceChain)} to ${
              cheapestCostRoute.route.destinationToken
            } on ${getNetworkName(cheapestCostRoute.route.destinationChain)}`,
            adapter: cheapestCostRoute.route.adapter,
            amountToTransfer: amountToTransferCapped.toString(),
            expectedFees: cheapestCostRoute.cost.toString(),
            deficitRemaining: deficitRemaining.toString(),
          });

          if (this.config.sendingTransactionsEnabled) {
            await this.adapters[cheapestCostRoute.route.adapter].initializeRebalance(
              cheapestCostRoute.route,
              amountToTransferCapped
            );
          }
        }
      }
    }
  }
}

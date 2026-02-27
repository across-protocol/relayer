import {
  assert,
  BigNumber,
  bnUint256Max,
  bnUint32Max,
  ConvertDecimals,
  forEachAsync,
  getNetworkName,
  getTokenInfoFromSymbol,
  isDefined,
  toBNWei,
} from "../../utils";
import { ExcessOrDeficit, RebalanceRoute } from "../utils/interfaces";
import { sortDeficitFunction, sortExcessFunction } from "../utils/utils";
import { BaseRebalancerClient } from "./BaseRebalancerClient";

export class SingleBalanceRebalancerClient extends BaseRebalancerClient {
  /**
   * @notice Rebalances inventory of current balances from chains where tokens are above configured targets to
   * chains where token balances are below configured thresholds. Is unaware of cumulative balances.
   * @param currentBalances Allow caller to pass in current allocation of balances. This is designed so that this
   * rebalancer can be seamessly used by the existing inventory manager client which has its own way of determining
   * allocations.
   * @dev A current balance entry must be set for each source chain + source token and destination chain + destination token
   * combination that has a rebalance route. A current balance entry must also be set for each target balance in the
   * client configuration.
   */
  override async rebalanceInventory(
    currentBalances: { [chainId: number]: { [token: string]: BigNumber } },
    maxFeePct: BigNumber
  ): Promise<void> {
    const targetBalances = this.config.targetBalances;

    // Assert that each target balance has a corresponding current balance.
    for (const [sourceToken, tokenConfig] of Object.entries(targetBalances)) {
      for (const [sourceChain] of Object.entries(tokenConfig)) {
        assert(
          isDefined(currentBalances[Number(sourceChain)]?.[sourceToken]),
          `RebalanceClient#rebalanceInventory: Undefined current balance for ${sourceToken} on ${getNetworkName(
            Number(sourceChain)
          )} which has a target balance`
        );
      }
    }
    const availableRebalanceRoutes = this.rebalanceRoutes.filter((route) => {
      return (
        isDefined(currentBalances[route.sourceChain]?.[route.sourceToken]) &&
        isDefined(currentBalances[route.destinationChain]?.[route.destinationToken]) &&
        isDefined(targetBalances[route.sourceToken]?.[route.sourceChain]) &&
        isDefined(targetBalances[route.destinationToken]?.[route.destinationChain])
      );
    });

    this.logger.debug({
      at: "SingleBalanceRebalancerClient.rebalanceInventory",
      message: "Available rebalance routes",
      currentBalances: Object.entries(currentBalances).map(([chainId, tokens]) => {
        return {
          [chainId]: Object.fromEntries(
            Object.entries(tokens).map(([token, balance]) => {
              return [token, balance.toString()];
            })
          ),
        };
      }),
      targetBalances: Object.entries(targetBalances).map(([token, chains]) => {
        return {
          [token]: Object.fromEntries(
            Object.entries(chains).map(([chainId, balance]) => {
              return [chainId, balance.targetBalance.toString()];
            })
          ),
        };
      }),
      availableRebalanceRoutes: availableRebalanceRoutes.map(
        (route) =>
          `(${route.adapter}) [${getNetworkName(route.sourceChain)}] ${route.sourceToken} -> [${getNetworkName(
            route.destinationChain
          )}] ${route.destinationToken}`
      ),
    });

    // Identify list of source chains that have excess balances and track the excess amounts for each token.
    const sourceChainsWithExcessBalances: ExcessOrDeficit[] = [];
    Object.entries(currentBalances).forEach(([chainId, tokens]) => {
      Object.entries(tokens).forEach(([token, balance]) => {
        const { priorityTier, targetBalance } = targetBalances[token][chainId];
        const hasExcess = balance.gt(targetBalance);
        if (!hasExcess) {
          return;
        }
        sourceChainsWithExcessBalances.push({
          token,
          chainId: Number(chainId),
          amount: balance.sub(targetBalance),
          priorityTier,
        });
      });
    });

    // Identify list of destination chains that have deficit balances and track the deficit amounts for each token.
    const destinationChainsWithDeficitBalances: ExcessOrDeficit[] = [];
    Object.entries(currentBalances).forEach(([chainId, tokens]) => {
      Object.entries(tokens).forEach(([token, balance]) => {
        const { priorityTier, targetBalance, thresholdBalance } = targetBalances[token][chainId];
        const hasDeficit = balance.lt(thresholdBalance);
        if (!hasDeficit) {
          return;
        }
        destinationChainsWithDeficitBalances.push({
          token,
          chainId: Number(chainId),
          amount: targetBalance.sub(balance),
          priorityTier,
        });
      });
    });

    // Sort deficits by priority tier and then by amount, where the resultant list is in descending order of priority tier.
    const sortedDeficits = destinationChainsWithDeficitBalances.sort(sortDeficitFunction);
    if (sortedDeficits.length > 0) {
      this.logger.debug({
        at: "SingleBalanceRebalancerClient.rebalanceInventory",
        message: "Sorted deficits",
        deficits: sortedDeficits.map(
          (d) =>
            `${getNetworkName(d.chainId)}: ${d.token} - ${d.amount.toString()} (priority tier: ${
              targetBalances[d.token][d.chainId].priorityTier
            })`
        ),
      });
    }

    // Sort excesses using opposite logic as deficits, where the resultant list is in ascending order of priority tier.
    const sortedExcesses = sourceChainsWithExcessBalances.sort(sortExcessFunction);
    if (sortedExcesses.length > 0) {
      this.logger.debug({
        at: "SingleBalanceRebalancerClient.rebalanceInventory",
        message: "Sorted excesses",
        excesses: sortedExcesses.map(
          (e) =>
            `${getNetworkName(e.chainId)}: ${e.token} - ${e.amount.toString()} (priority tier: ${
              targetBalances[e.token][e.chainId].priorityTier
            })`
        ),
      });
    }

    const getDeficitAmountCapped = (
      sourceChainId: number,
      sourceToken: string,
      destinationChainId: number,
      destinationToken: string,
      deficitAmount: BigNumber
    ) => {
      const sourceChainMaxAmountToTransfer =
        this.config.maxAmountsToTransfer[sourceToken]?.[sourceChainId] ??
        ConvertDecimals(6, getTokenInfoFromSymbol(sourceToken, Number(sourceChainId)).decimals)(bnUint32Max);
      const converterFromDestinationToSource = ConvertDecimals(
        getTokenInfoFromSymbol(destinationToken, Number(destinationChainId)).decimals,
        getTokenInfoFromSymbol(sourceToken, Number(sourceChainId)).decimals
      );
      return sourceChainMaxAmountToTransfer.gt(converterFromDestinationToSource(deficitAmount))
        ? converterFromDestinationToSource(deficitAmount)
        : sourceChainMaxAmountToTransfer;
    };

    // Now, go through each deficit and attempt to fill it with an excess balance, using the lowest priority excesses first.
    for (const deficit of sortedDeficits) {
      const { chainId: destinationChainId, token: destinationToken, amount: deficitAmount } = deficit;

      // Find the first excess that can be used to fill the deficit. We must make sure that the source chain and destination chain
      // are associated with a rebalance route.
      let rebalanceRouteToUse: RebalanceRoute | undefined;
      let cheapestExpectedCost = bnUint256Max;
      let matchingExcess: ExcessOrDeficit | undefined;
      this.logger.debug({
        at: "SingleBalanceRebalancerClient.rebalanceInventory",
        message: `Filling deficit of ${deficitAmount.toString()} of ${destinationToken} on ${getNetworkName(
          destinationChainId
        )}`,
      });

      const availableAdapters = await this.getAvailableAdapters();
      if (availableAdapters.length === 0) {
        // We break here rather than continue because we assume that pending orders cannot progress while we're
        // in this function.
        this.logger.debug({
          at: "SingleBalanceRebalancerClient.rebalanceInventory",
          message: "No available adapters to fill deficits",
        });
        break;
      }

      for (let i = 0; i < sortedExcesses.length; i++) {
        const excess = sortedExcesses[i];
        const { chainId: sourceChainId, token: sourceToken, amount: excessAmount } = excess;
        // We assume here that the tokens are worth the same price,
        // as we'd need to normalize to USD terms to determine if an excess can fill a deficit otherwise.
        const deficitAmountCapped = getDeficitAmountCapped(
          sourceChainId,
          sourceToken,
          destinationChainId,
          destinationToken,
          deficitAmount
        );
        if (excessAmount.lt(deficitAmountCapped)) {
          continue;
        }

        await forEachAsync(this.rebalanceRoutes, async (r) => {
          if (
            availableAdapters.includes(r.adapter) &&
            r.sourceChain === sourceChainId &&
            r.sourceToken === sourceToken &&
            r.destinationChain === destinationChainId &&
            r.destinationToken === destinationToken
          ) {
            this.logger.debug({
              at: "SingleBalanceRebalancerClient.rebalanceInventory",
              message: `Evaluating excess of ${excessAmount.toString()} of ${sourceToken} on ${getNetworkName(
                sourceChainId
              )}`,
              deficit: deficitAmount.toString(),
              deficitChain: getNetworkName(destinationChainId),
              deficitToken: destinationToken,
            });
            // Check the estimated cost for this route and replace the best route if this one is cheaper.
            const expectedCostForRebalance = await this.adapters[r.adapter].getEstimatedCost(
              r,
              deficitAmountCapped,
              true
            );
            if (expectedCostForRebalance.lt(cheapestExpectedCost)) {
              cheapestExpectedCost = expectedCostForRebalance;
              rebalanceRouteToUse = r;
            }
          }
        });

        // No matching rebalance routes for this excess->deficit flow so we need to evaluate the next excess.
        if (!isDefined(rebalanceRouteToUse)) {
          continue;
        }
        matchingExcess = excess;
        const maxFee = deficitAmountCapped.mul(maxFeePct).div(toBNWei(100));
        if (cheapestExpectedCost.gt(maxFee)) {
          this.logger.debug({
            at: "SingleBalanceRebalancerClient.rebalanceInventory",
            message: `Cheapest expected cost ${cheapestExpectedCost.toString()} is greater than max fee ${maxFee.toString()}, exiting`,
          });
          continue;
        }

        // We have a matching excess now, we can exit this loop and move on to the next deficit.
        this.logger.debug({
          at: "SingleBalanceRebalancerClient.rebalanceInventory",
          message: `Using cheapest rebalance route for ${sourceToken} on ${getNetworkName(
            sourceChainId
          )} to fill the deficit of ${deficitAmount.toString()} of ${destinationToken} on ${getNetworkName(
            destinationChainId
          )}: ${rebalanceRouteToUse.adapter}`,
          cheapestExpectedCost: cheapestExpectedCost.toString(),
          deficitAmountCapped: deficitAmountCapped.toString(),
          excessAmount: excessAmount.toString(),
          newExcessAmount: excessAmount.sub(deficitAmountCapped).toString(),
        });

        // We found a matching excess, let's now modify the existing excess amount list so we don't overdraw this excess.
        sortedExcesses[i].amount = excessAmount.sub(deficitAmountCapped);
        break;
      }
      if (!isDefined(matchingExcess)) {
        // We get here if there are no rebalance routes that would fulfill
        // this deficit that also happen to have an excess on the rebalance route's source chain. In other words,
        // we can't fill this deficit so we need to move on.
        this.logger.debug({
          at: "SingleBalanceRebalancerClient.rebalanceInventory",
          message: `No excess balances with matching rebalance routes found to fill the deficit of ${deficitAmount.toString()} of ${destinationToken} on ${getNetworkName(
            destinationChainId
          )}, skipping this deficit`,
          sortedExcesses: sortedExcesses.map(
            (e) => `${getNetworkName(e.chainId)}: ${e.token} - ${e.amount.toString()}`
          ),
        });
        continue;
      }
      const { sourceToken, sourceChain, adapter } = rebalanceRouteToUse;

      // Add the expected cost to the deficit amount to get the total amount to transfer. This way we end up with
      // the expected amount to receive after fees.
      const deficitAmountCapped = getDeficitAmountCapped(
        sourceChain,
        sourceToken,
        destinationChainId,
        destinationToken,
        deficitAmount
      );
      const amountToTransfer = deficitAmountCapped.add(cheapestExpectedCost);
      // Initiate a new rebalance
      this.logger.debug({
        at: "RebalanceClient.rebalanceInventory",
        message: `Initializing new ${adapter} rebalance from ${sourceToken} on ${getNetworkName(
          sourceChain
        )} to ${destinationToken} on ${getNetworkName(destinationChainId)}`,
        adapter,
        amountToTransfer: amountToTransfer.toString(),
        expectedFees: cheapestExpectedCost.toString(),
      });

      if (this.config.sendingTransactionsEnabled) {
        await this.adapters[adapter].initializeRebalance(rebalanceRouteToUse, amountToTransfer);
      }
    }
  }
}

import {
  assert,
  BigNumber,
  bnUint256Max,
  bnZero,
  ConvertDecimals,
  forEachAsync,
  getNetworkName,
  isDefined,
  Signer,
  toBNWei,
  winston,
  getTokenInfoFromSymbol,
  bnUint32Max,
  mapAsync,
} from "../utils";
import { RebalancerConfig } from "./RebalancerConfig";
export interface RebalanceRoute {
  sourceChain: number;
  destinationChain: number;
  sourceToken: string;
  destinationToken: string;
  adapter: string; // Name of adapter to use for this rebalance.
}

export interface RebalancerClient {
  getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }>;
}

/**
 * @notice This class is a successor to the InventoryClient. It is in charge of rebalancing inventory of the user
 * across all chains given the current and configured target allocations.
 * @dev Different concrete rebalancer clients can share this base while implementing different
 * inventory-rebalancing modes.
 */
export abstract class BaseRebalancerClient implements RebalancerClient {
  constructor(
    readonly logger: winston.Logger,
    readonly config: RebalancerConfig,
    readonly adapters: { [name: string]: RebalancerAdapter },
    readonly rebalanceRoutes: RebalanceRoute[],
    readonly baseSigner: Signer
  ) {}

  async initialize(): Promise<void> {
    for (const adapter of Object.values(this.adapters)) {
      await adapter.initialize(this.rebalanceRoutes);
    }
  }

  abstract rebalanceInventory(...args: unknown[]): Promise<void>;

  /**
   * @notice Get all currently unfinalized rebalance amounts. Should be used to add virtual balance credits or
   * debits for the token and chain combinations.
   * @return Dictionary of chainId -> token -> amount where positive amounts present pending rebalance credits to that
   * chain while negative amounts represent debits that should be subtracted from that chain's current balance.
   */
  async getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }> {
    const pendingRebalances: { [chainId: number]: { [token: string]: BigNumber } } = {};
    await forEachAsync(Object.values(this.adapters), async (adapter) => {
      const pending = await adapter.getPendingRebalances();
      Object.entries(pending).forEach(([chainId, tokenBalance]) => {
        Object.entries(tokenBalance).forEach(([token, amount]) => {
          pendingRebalances[chainId] ??= {};
          pendingRebalances[chainId][token] = (pendingRebalances[chainId]?.[token] ?? bnZero).add(amount);
        });
      });
    });
    return pendingRebalances;
  }

  protected async getAvailableAdapters(): Promise<string[]> {
    // Check if there are already too many pending orders for this adapter.
    const availableAdapters: Set<string> = new Set();
    for (const adapter of Object.keys(this.adapters)) {
      const pendingOrders = await this.adapters[adapter].getPendingOrders();
      const maxPendingOrdersForAdapter = this.config.maxPendingOrders[adapter] ?? 2; // @todo Default low for now,
      // eventually change this to a very high default value.
      if (pendingOrders.length < maxPendingOrdersForAdapter) {
        availableAdapters.add(adapter);
      } else {
        this.logger.debug({
          at: "RebalanceClient.rebalanceInventory",
          message: `Too many pending orders (${pendingOrders.length}) for ${adapter} adapter, rejecting new rebalances`,
          maxPendingOrdersForAdapter,
        });
      }
    }
    return Array.from(availableAdapters);
  }
}

export class ReadOnlyRebalancerClient extends BaseRebalancerClient {
  override async rebalanceInventory(): Promise<void> {
    throw new Error("ReadOnlyRebalancerClient does not support rebalancing inventory");
  }
}
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
    const sourceChainsWithExcessBalances: { [chainId: number]: { [token: string]: BigNumber } } = {};
    availableRebalanceRoutes.forEach((rebalanceRoute) => {
      const { sourceChain, sourceToken } = rebalanceRoute;
      const currentBalance = currentBalances[sourceChain][sourceToken];
      const targetBalance = targetBalances[sourceToken][sourceChain].targetBalance;
      const hasExcess = currentBalance.gt(targetBalance);
      if (!hasExcess) {
        return;
      }
      sourceChainsWithExcessBalances[sourceChain] ??= {};
      // If we've already seen this source chain + token, then the following calculation is repetitive and we can skip.
      if (sourceChainsWithExcessBalances[sourceChain]?.[sourceToken]) {
        return;
      }

      sourceChainsWithExcessBalances[sourceChain][sourceToken] = currentBalance.sub(targetBalance);
      this.logger.debug({
        message: `Excess balance for ${sourceToken} on ${getNetworkName(sourceChain)}`,
        targetBalance: targetBalance.toString(),
        currentBalance: currentBalance.toString(),
        excess: sourceChainsWithExcessBalances[sourceChain][sourceToken].toString(),
      });
    });

    // Identify list of destination chains that have deficit balances and track the deficit amounts for each token.
    const destinationChainsWithDeficitBalances: { [chainId: number]: { [token: string]: BigNumber } } = {};
    availableRebalanceRoutes.forEach((rebalanceRoute) => {
      const { destinationChain, destinationToken } = rebalanceRoute;
      const currentBalance = currentBalances[destinationChain][destinationToken];

      const { targetBalance, thresholdBalance } = targetBalances[destinationToken][destinationChain];
      // Only count a balance as deficit if its below the threshold which should be <= targetBalance.
      const hasDeficit = currentBalance.lt(thresholdBalance);
      if (!hasDeficit) {
        return;
      }
      destinationChainsWithDeficitBalances[destinationChain] ??= {};
      // If we've already seen this destination chain + token, then the following calculation is repetitive and we can skip.
      if (destinationChainsWithDeficitBalances[destinationChain]?.[destinationToken]) {
        return;
      }

      destinationChainsWithDeficitBalances[destinationChain][destinationToken] = targetBalance.sub(currentBalance);
      this.logger.debug({
        message: `Deficit balance for ${destinationToken} on ${getNetworkName(destinationChain)}`,
        targetBalance: targetBalance.toString(),
        thresholdBalance: thresholdBalance.toString(),
        currentBalance: currentBalance.toString(),
        deficit: destinationChainsWithDeficitBalances[destinationChain][destinationToken].toString(),
      });
    });

    // Sort deficits by priority tier and then by amount, where the resultant list is in descending order of priority tier.
    const sortedDeficits: { chainId: number; token: string; deficitAmount: BigNumber }[] = [];
    Object.entries(destinationChainsWithDeficitBalances).forEach(([chainId, tokens]) => {
      Object.entries(tokens).forEach(([token, deficitAmount]) => {
        const priorityTier = targetBalances[token][chainId].priorityTier;
        // Insert deficit into sortedDeficits in the correct position using priority tier first and then amount to
        // rank entries.
        const index = sortedDeficits.findIndex((existing) => {
          const { chainId: _chainId, token: _token, deficitAmount: _deficitAmount } = existing;
          const _priorityTier = targetBalances[_token][_chainId].priorityTier;
          // If existing entry has a higher priority tier, then the new entry should be inserted after it.
          if (_priorityTier > priorityTier) {
            return false;
          }
          // If existing entry has a lower priority tier, then the new entry should be inserted before it. Assuming
          // that sortedDeficits is already sorted properly, then we can simply return here if we find an existing
          // entry with a lower priority tier than the new entry.
          if (_priorityTier < priorityTier) {
            return true;
          }

          // Priority tiers are equal, compare amounts. We want higher deficits to be prioritized.
          const tokenDecimals = getTokenInfoFromSymbol(token, Number(chainId)).decimals;
          const _tokenDecimals = getTokenInfoFromSymbol(_token, Number(_chainId)).decimals;
          const amountConverter = ConvertDecimals(_tokenDecimals, tokenDecimals);
          return amountConverter(_deficitAmount).lt(deficitAmount);
        });
        // If index is -1, then the new entry should be the last entry in the list.
        if (index === -1) {
          sortedDeficits.push({ chainId: Number(chainId), token, deficitAmount });
          return;
        }
        sortedDeficits.splice(index, 0, { chainId: Number(chainId), token, deficitAmount });
      });
    });
    if (sortedDeficits.length > 0) {
      this.logger.debug({
        at: "SingleBalanceRebalancerClient.rebalanceInventory",
        message: "Sorted deficits",
        deficits: sortedDeficits.map(
          (d) =>
            `${getNetworkName(d.chainId)}: ${d.token} - ${d.deficitAmount.toString()} (priority tier: ${
              targetBalances[d.token][d.chainId].priorityTier
            })`
        ),
      });
    }

    // Sort excesses using opposite logic as deficits, where the resultant list is in ascending order of priority tier.
    const sortedExcesses: { chainId: number; token: string; excessAmount: BigNumber }[] = [];
    Object.entries(sourceChainsWithExcessBalances).forEach(([chainId, tokens]) => {
      Object.entries(tokens).forEach(([token, excessAmount]) => {
        const priorityTier = targetBalances[token][chainId].priorityTier;
        // Insert excess into sortedExcesses in the correct position using priority tier first and then amount to
        // rank entries.
        const index = sortedExcesses.findIndex((existing) => {
          const { chainId: _chainId, token: _token, excessAmount: _excessAmount } = existing;
          const _priorityTier = targetBalances[_token][_chainId].priorityTier;
          // If existing entry has a lower priority tier, then the new entry should be inserted after it.
          if (_priorityTier < priorityTier) {
            return false;
          }
          // If existing entry has a higher priority tier, then the new entry should be inserted before it. Assuming
          // that sortedDeficits is already sorted properly, then we can simply return here if we find an existing
          // entry with a higher priority tier than the new entry.
          if (_priorityTier > priorityTier) {
            return true;
          }

          // Priority tiers are equal, compare amounts. We want higher excesses to be prioritized.
          const tokenDecimals = getTokenInfoFromSymbol(token, Number(chainId)).decimals;
          const _tokenDecimals = getTokenInfoFromSymbol(_token, Number(_chainId)).decimals;
          const amountConverter = ConvertDecimals(_tokenDecimals, tokenDecimals);
          return amountConverter(_excessAmount).lt(excessAmount);
        });
        // If index is -1, then the new entry should be the last entry in the list.
        if (index === -1) {
          sortedExcesses.push({ chainId: Number(chainId), token, excessAmount });
          return;
        }
        sortedExcesses.splice(index, 0, { chainId: Number(chainId), token, excessAmount });
      });
    });
    if (sortedExcesses.length > 0) {
      this.logger.debug({
        at: "SingleBalanceRebalancerClient.rebalanceInventory",
        message: "Sorted excesses",
        excesses: sortedExcesses.map(
          (e) =>
            `${getNetworkName(e.chainId)}: ${e.token} - ${e.excessAmount.toString()} (priority tier: ${
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
      const { chainId: destinationChainId, token: destinationToken, deficitAmount } = deficit;

      // Find the first excess that can be used to fill the deficit. We must make sure that the source chain and destination chain
      // are associated with a rebalance route.
      let rebalanceRouteToUse: RebalanceRoute | undefined;
      let cheapestExpectedCost = bnUint256Max;
      let matchingExcess: { chainId: number; token: string; excessAmount: BigNumber } | undefined;
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
        const { chainId: sourceChainId, token: sourceToken, excessAmount } = excess;
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
        sortedExcesses[i].excessAmount = excessAmount.sub(deficitAmountCapped);
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
            (e) => `${getNetworkName(e.chainId)}: ${e.token} - ${e.excessAmount.toString()}`
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

      if (process.env.SEND_TRANSACTIONS === "true") {
        await this.adapters[adapter].initializeRebalance(rebalanceRouteToUse, amountToTransfer);
      }
    }
  }
}

export class CumulativeBalanceRebalancerClient extends BaseRebalancerClient {
  /**
   * @notice Rebalances cumulative balances of tokens across chains where cumulative token balances are above
   * configured targets to to tokens that have cumulative balances below configured thresholds. Tokens are sourced
   * from chains sorted by configured priority tier and current balance level.
   * @param cumulativeBalances Dictionary of token -> cumulative balance.
   * @param currentBalances Dictionary of chainId -> token -> current balance.
   * @param maxFeePct Maximum fee percentage to allow for rebalances.
   */
  override async rebalanceInventory(
    cumulativeBalances: { [token: string]: BigNumber },
    currentBalances: { [chainId: number]: { [token: string]: BigNumber } },
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
        isDefined(currentBalances[route.sourceChain]?.[route.sourceToken]) &&
        isDefined(currentBalances[route.destinationChain]?.[route.destinationToken]) &&
        isDefined(cumulativeTargetBalances[route.sourceToken]?.chains?.[route.sourceChain]) &&
        isDefined(cumulativeTargetBalances[route.destinationToken]?.chains?.[route.destinationChain])
      );
    });

    this.logger.debug({
      at: "CumulativeBalanceRebalancerClient.rebalanceInventory",
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
    const sortedDeficits: { token: string; deficitAmount: BigNumber }[] = [];
    const sortedExcesses: { token: string; excessAmount: BigNumber }[] = [];
    for (const [token, cumulativeBalance] of Object.entries(cumulativeBalances)) {
      // If current balance is below threshold, we want to refill back to target balance.
      const { targetBalance, thresholdBalance } = cumulativeTargetBalances[token];
      const currentCumulativeBalance = cumulativeBalances[token];
      if (currentCumulativeBalance.lt(thresholdBalance)) {
        const deficitAmount = targetBalance.sub(cumulativeBalance);
        sortedDeficits.push({ token, deficitAmount });
      } else if (currentCumulativeBalance.gt(targetBalance)) {
        const excessAmount = currentCumulativeBalance.sub(targetBalance);
        sortedExcesses.push({ token, excessAmount });
      }
    }
    // Sort deficits by priority from highest to lowest and then by size from largest to smallest.
    sortedDeficits.sort(
      ({ token: tokenA, deficitAmount: deficitAmountA }, { token: tokenB, deficitAmount: deficitAmountB }) => {
        const priorityTierA = cumulativeTargetBalances[tokenA].priorityTier;
        const priorityTierB = cumulativeTargetBalances[tokenB].priorityTier;
        if (priorityTierA !== priorityTierB) {
          return priorityTierB - priorityTierA;
        }
        if (deficitAmountA.eq(deficitAmountB)) {
          return 0;
        }
        return deficitAmountA.gt(deficitAmountB) ? -1 : 1;
      }
    );
    if (sortedDeficits.length > 0) {
      this.logger.debug({
        at: "CumulativeBalanceRebalancerClient.rebalanceInventory",
        message: "Sorted deficits",
        deficits: sortedDeficits.map(
          (e) =>
            `${e.token} - ${e.deficitAmount.toString()} (priority tier: ${
              cumulativeTargetBalances[e.token].priorityTier
            })`
        ),
      });
    }
    // Sort excesses by priority from lowest to highest and then by size from largest to smallest.
    sortedExcesses.sort(
      ({ token: tokenA, excessAmount: excessAmountA }, { token: tokenB, excessAmount: excessAmountB }) => {
        const priorityTierA = cumulativeTargetBalances[tokenA].priorityTier;
        const priorityTierB = cumulativeTargetBalances[tokenB].priorityTier;
        if (priorityTierA !== priorityTierB) {
          return priorityTierA - priorityTierB;
        }
        if (excessAmountA.eq(excessAmountB)) {
          return 0;
        }
        return excessAmountA.gt(excessAmountB) ? -1 : 1;
      }
    );
    if (sortedExcesses.length > 0) {
      this.logger.debug({
        at: "CumulativeBalanceRebalancerClient.rebalanceInventory",
        message: "Sorted excesses",
        excesses: sortedExcesses.map(
          (e) =>
            `${e.token} - ${e.excessAmount.toString()} (priority tier: ${
              cumulativeTargetBalances[e.token].priorityTier
            })`
        ),
      });
    }

    // Iterate through the sorted deficits and try to fill as much of it as possible from the configured
    // excess token chain list.
    for (const deficit of sortedDeficits) {
      const { token: deficitToken, deficitAmount } = deficit;
      // Keep track of how much of the deficit we need to fill and also how much excess we have available to send.
      let deficitRemaining = deficitAmount;
      for (const excess of sortedExcesses) {
        const { token: excessToken, excessAmount } = excess;
        let excessRemaining = excessAmount;

        // Sort all the chains with excess tokens by priority from lowest to highest and then by current balance from highest to lowest.
        const excessSourceChainsForToken = Object.entries(cumulativeTargetBalances[excessToken].chains).filter(
          ([chainId]) => {
            return isDefined(currentBalances[chainId]?.[excessToken]);
          }
        );
        const sortedExcessSourceChainsForToken = excessSourceChainsForToken.sort(
          ([chainIdA, priorityTierA], [chainIdB, priorityTierB]) => {
            if (priorityTierA !== priorityTierB) {
              return priorityTierA - priorityTierB;
            }
            const tokenDecimalsA = getTokenInfoFromSymbol(excessToken, Number(chainIdA)).decimals;
            const tokenDecimalsB = getTokenInfoFromSymbol(excessToken, Number(chainIdB)).decimals;
            const amountConverter = ConvertDecimals(tokenDecimalsA, tokenDecimalsB);
            const currentBalanceA = amountConverter(currentBalances[chainIdA][excessToken]);
            const currentBalanceB = currentBalances[chainIdB][excessToken];
            if (currentBalanceA.eq(currentBalanceB)) {
              return 0;
            }
            return currentBalanceA.gt(currentBalanceB) ? -1 : 1;
          }
        );
        this.logger.debug({
          at: "CumulativeBalanceRebalancerClient.rebalanceInventory",
          message: `Sorted excess source chains for token ${excessToken}`,
          excessSourceChainsForToken: sortedExcessSourceChainsForToken.map(([chainId]) => {
            return {
              [chainId]: currentBalances[chainId][excessToken].toString(),
            };
          }),
        });

        // Iterate through potential excess source chains and remove any that don't have rebalance routes or have
        // fees that exceed the max fee percentage.
        for (const [chainId] of sortedExcessSourceChainsForToken) {
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
          const chainToL1Converter = ConvertDecimals(chainDecimals, l1TokenDecimals);
          const excessRemainingConverted = l1ToChainConverter(excessRemaining);
          const deficitRemainingConverted = l1ToChainConverter(deficitRemaining);
          // The max we can transfer is the minimum of {the remaining deficit, the remaining excess, the max amount to transfer, the current balance}
          const currentBalance = currentBalances[chainId][excessToken];
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
              cost: await this.adapters[route.adapter].getEstimatedCost(route, amountToTransferCapped, false),
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

          if (process.env.SEND_TRANSACTIONS === "true") {
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

export interface RebalancerAdapter {
  initialize(availableRoutes: RebalanceRoute[]): Promise<void>;
  initializeRebalance(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<void>;
  updateRebalanceStatuses(): Promise<void>;
  sweepIntermediateBalances(): Promise<void>;

  // Get all currently unfinalized rebalance amounts. Should be used to add a virtual balance credit for the chain
  // + token in question.
  getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }>;
  getPendingOrders(): Promise<string[]>;
  getEstimatedCost(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber, debugLog: boolean): Promise<BigNumber>;
}

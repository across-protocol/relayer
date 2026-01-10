import { TOKEN_SYMBOLS_MAP } from "@across-protocol/contracts";
import {
  assert,
  BigNumber,
  bnUint256Max,
  ConvertDecimals,
  forEachAsync,
  getNetworkName,
  isDefined,
  Signer,
  toBNWei,
  winston,
} from "../utils";
import { RebalancerConfig } from "./RebalancerConfig";

interface ChainConfig {
  // This should be possible to set to 0 (to indicate that a chain should hold zero funds) or
  // positive infinity (to indicate that a chain should be the universal sink for the given token).
  targetBalance: BigNumber;
  // Set this higher to prioritize returning this balance (if below target) back to target or deprioritize
  // sending this balance when above target.
  priorityTier: number;
}

interface TokenConfig {
  [chainId: number]: ChainConfig;
}

export interface TargetBalanceConfig {
  [token: string]: TokenConfig;
}

export interface RebalanceRoute {
  sourceChain: number;
  destinationChain: number;
  sourceToken: string;
  destinationToken: string;
  maxAmountToTransfer: BigNumber; // Assumed to be a source chain amount.
  adapter: string; // Name of adapter to use for this rebalance.
}

/**
 * @notice This class is a successor to the InventoryClient. It is in charge of rebalancing inventory of the user
 * across all chains given the current and configured target allocations.
 */
export class RebalancerClient {
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

  /**
   *
   * @param currentBalances Allow caller to pass in current allocation of balances. This is designed so that this
   * rebalancer can be seamessly used by the existing inventory manager client which has its own way of determining
   * allocations.
   * @dev A current balance entry must be set for each source chain + source token and destination chain + destination token
   * combination that has a rebalance route. A current balance entry must also be set for each target balance in the
   * client configuration.
   */
  async rebalanceInventory(
    currentBalances: { [chainId: number]: { [token: string]: BigNumber } },
    maxFeePct: BigNumber
  ): Promise<void> {
    // Assert that each current balance maps to a target balance.
    for (const [sourceToken, tokenConfig] of Object.entries(this.config.targetBalances)) {
      for (const [sourceChain] of Object.entries(tokenConfig)) {
        assert(
          isDefined(currentBalances[Number(sourceChain)]?.[sourceToken]),
          `RebalanceClient#rebalanceInventory: Undefined current balance for ${sourceToken} on ${getNetworkName(
            Number(sourceChain)
          )} which has a target balance`
        );
      }
    }
    const targetBalances = this.config.targetBalances;
    const availableRebalanceRoutes = this.rebalanceRoutes.filter((route) => {
      return (
        isDefined(currentBalances[route.sourceChain]?.[route.sourceToken]) &&
        isDefined(currentBalances[route.destinationChain]?.[route.destinationToken]) &&
        isDefined(targetBalances[route.sourceToken]?.[route.sourceChain]) &&
        isDefined(targetBalances[route.destinationToken]?.[route.destinationChain])
      );
    });

    this.logger.debug({
      at: "RebalancerClient.rebalanceInventory",
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

      // If target is greater than the maxAmountToTransfer for this route, set target to maxAmountToTransfer.
      const targetBalance = targetBalances[destinationToken][destinationChain].targetBalance;
      const hasDeficit = currentBalance.lt(targetBalance);
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
        currentBalance: currentBalance.toString(),
        deficit: destinationChainsWithDeficitBalances[destinationChain][destinationToken].toString(),
      });
    });

    // Sort deficits by priority tier and then by amount, where the resultant list is in descending order of priority tier and then amount.
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

          // Priority tiers are equal, compare amounts. If amounts are equal, give weight to the existing entry.
          return _deficitAmount.lt(deficitAmount);
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
        at: "RebalancerClient.rebalanceInventory",
        message: "Sorted deficits",
        deficits: sortedDeficits.map(
          (d) =>
            `${getNetworkName(d.chainId)}: ${d.token} - ${d.deficitAmount.toString()} (priority tier: ${
              targetBalances[d.token][d.chainId].priorityTier
            })`
        ),
      });
    }

    // Sort excesses using opposite logic as deficits, where the resultant list is in ascending order of priority tier and then amount.
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

          // Priority tiers are equal, compare amounts. If amounts are equal, give weight to the existing entry.
          return _excessAmount.gt(excessAmount);
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
        at: "RebalancerClient.rebalanceInventory",
        message: "Sorted excesses",
        excesses: sortedExcesses.map(
          (e) =>
            `${getNetworkName(e.chainId)}: ${e.token} - ${e.excessAmount.toString()} (priority tier: ${
              targetBalances[e.token][e.chainId].priorityTier
            })`
        ),
      });
    }

    // Now, go through each deficit and attempt to fill it with an excess balance, using the lowest priority excesses first.
    for (const deficit of sortedDeficits) {
      const { chainId: destinationChainId, token: destinationToken, deficitAmount } = deficit;

      // Find the first excess that can be used to fill the deficit. We must make sure that the source chain and destination chain
      // are associated with a rebalance route.
      let rebalanceRouteToUse: RebalanceRoute | undefined;
      let cheapestExpectedCost = bnUint256Max;
      let matchingExcess: { chainId: number; token: string; excessAmount: BigNumber } | undefined;
      await forEachAsync(sortedExcesses, async (excess, excessIndex) => {
        const { chainId: sourceChainId, token: sourceToken, excessAmount } = excess;
        // Convert excess to deficit token decimals. Also, we assume here that the tokens are worth the same price,
        // as we'd need to normalize to USD terms to determine if an excess can fill a deficit otherwise.
        const amountConverter = ConvertDecimals(
          TOKEN_SYMBOLS_MAP[destinationToken].decimals,
          TOKEN_SYMBOLS_MAP[sourceToken].decimals
        );
        // @todo: Prioritize rebalance routes based on estimated cost and also be aware of user's fee cap.
        // We need this function to take in a fee cap to handle this logic.
        await forEachAsync(this.rebalanceRoutes, async (r) => {
          // For this rebalance route, cap the deficit amount at the maxAmountToTransfer for this route.
          const deficitAmountCapped = r.maxAmountToTransfer.gt(deficitAmount) ? deficitAmount : r.maxAmountToTransfer;
          if (
            r.sourceChain === sourceChainId &&
            r.sourceToken === sourceToken &&
            r.destinationChain === destinationChainId &&
            r.destinationToken === destinationToken &&
            amountConverter(excessAmount).gte(deficitAmountCapped)
          ) {
            // Check the estimated cost for this route and replace the best route if this one is cheaper.
            const expectedCostForRebalance = await this.adapters[r.adapter].getEstimatedCost(
              r,
              deficitAmountCapped,
              true
            );
            this.logger.debug({
              at: "RebalancerClient.rebalanceInventory",
              message: `Expected cost to use rebalance route ${
                r.adapter
              } denominated in source tokens is ${expectedCostForRebalance.toString()}`,
              expectedCostForRebalance: expectedCostForRebalance.toString(),
            });
            if (expectedCostForRebalance.lt(cheapestExpectedCost)) {
              cheapestExpectedCost = expectedCostForRebalance;
              rebalanceRouteToUse = r;
            }
          }
        });
        if (!isDefined(rebalanceRouteToUse)) {
          return;
        }
        matchingExcess = excess;

        const deficitAmountCapped = rebalanceRouteToUse.maxAmountToTransfer.gt(deficitAmount)
          ? deficitAmount
          : rebalanceRouteToUse.maxAmountToTransfer;
        const maxFee = deficitAmountCapped.mul(maxFeePct).div(toBNWei(100));
        if (cheapestExpectedCost.gt(maxFee)) {
          this.logger.debug({
            at: "RebalancerClient.rebalanceInventory",
            message: `Cheapest expected cost ${cheapestExpectedCost.toString()} is greater than max fee ${maxFee.toString()}, exiting`,
          });
          return;
        }

        this.logger.debug({
          at: "RebalancerClient.rebalanceInventory",
          message: `Using cheapest rebalance route for ${sourceToken} on ${getNetworkName(
            sourceChainId
          )} to fill the deficit of ${deficitAmount.toString()} of ${destinationToken} on ${getNetworkName(
            destinationChainId
          )}: ${rebalanceRouteToUse.adapter}`,
          cheapestExpectedCost: cheapestExpectedCost.toString(),
          deficitAmountCapped: deficitAmountCapped.toString(),
          newExcessAmount: excessAmount.sub(deficitAmountCapped).toString(),
        });

        // We found a matching excess, let's now modify the existing excess amount list so we don't overdraw this excess.
        sortedExcesses[excessIndex].excessAmount = excessAmount.sub(deficitAmountCapped);
      });
      if (!isDefined(matchingExcess)) {
        // @todo: This log could be clarified better. We get here if there are no rebalance routes that would fulfill
        // this deficit that also happen to have an excess on the rebalance route's source chain.
        continue;
      }
      const deficitAmountCapped = rebalanceRouteToUse.maxAmountToTransfer.gt(deficitAmount)
        ? deficitAmount
        : rebalanceRouteToUse.maxAmountToTransfer;

      // Add the expected cost to the deficit amount to get the total amount to transfer. This way we end up with
      // the expected amount to receive after fees.
      const amountToTransfer = deficitAmountCapped.add(cheapestExpectedCost);

      // Initiate a new rebalance
      this.logger.debug({
        at: "RebalanceClient.rebalanceInventory",
        message: `Initializing new ${rebalanceRouteToUse.adapter} rebalance from ${
          rebalanceRouteToUse.sourceToken
        } on ${getNetworkName(rebalanceRouteToUse.sourceChain)} to ${
          rebalanceRouteToUse.destinationToken
        } on ${getNetworkName(rebalanceRouteToUse.destinationChain)}`,
        adapter: rebalanceRouteToUse.adapter,
        amountToTransfer: amountToTransfer.toString(),
        expectedFees: cheapestExpectedCost.toString(),
      });

      await this.adapters[rebalanceRouteToUse.adapter].initializeRebalance(rebalanceRouteToUse, amountToTransfer);
    }

    // Setup:
    // - We can only rebalance via rebalance routes from source chains + tokens to destination chains + tokens.
    // - From the rebalance route list, load all chains and tokens we need to query:
    //   - Set of all source chains + source tokens
    //   - Set of all destination chains + destination tokens
    // - For each chain + token:
    //   - Load all current balances per chain including pending rebalances.
    //   - We should define these balances in $ terms to normalize them, therefore we'll need a price oracle for each token.
    // Run:
    // - Identify list of source chains that have EXCESS balances.
    // - Identify list of destination chains that have DEFICIT balances.
    // - Our goal is to attempt to send funds from excess balances to refill deficit balances.
    // - We do not attempt to reduce excess balances unless there is a deficit to refill. Absent anu deficits,
    //   excesses are ok.
    // - The user might find it helpful to define a chain as a "universal source" by setting its target balance to 0,
    //   therefore that chain always has an excess balance.
    // - Similarly, the user might find it helpful to define a "universal sink" by setting its target balance to positive
    //   infinity, therefore that chain always has a deficit balance.
    // - For each DEFICIT chain, query all rebalance routes TO that chain that have an "excess" balance
    //   large enough to cover the deficit (excess = current balance - target balance).
    //    - Note: This should include both swap and bridge routes, so you could theoretically fill deficits in USDC using
    //      by drawing from excesses in USDT.
    // - If resultant route list is empty, log a warning.
    // - Otherwise, call initializeRebalance() for that route using the "cheapest" route whose cost is under the
    //   max allowable cost. We'll need to query route.adapter.getCostEstimate to figure out the cost of the route.
    // - To avoid duplicate rebalances, the adapters should correctly implement getPendingRebalances() so that this
    //   client computes current balances correctly.

    // for (const deficit of  deficits) {
    //   const routes = this.getRebalanceRoutesToChain(deficit.chain, deficit.token, deficit.amount);
    //   const cheapestRoute = routes.filter((route) => route.adapter.getCostEstimate(route) < maxCost).sort((a, b) => a.cost - b.cost)[0];
    //   await this.adapters.hyperliquid.initializeRebalance(cheapestRoute);
    // }
  }
}

export interface RebalancerAdapter {
  initialize(availableRoutes: RebalanceRoute[]): Promise<void>;
  initializeRebalance(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<void>;
  updateRebalanceStatuses(): Promise<void>;

  // Get all currently unfinalized rebalance amounts. Should be used to add a virtual balance credit for the chain
  // + token in question.
  getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }>;
  getEstimatedCost(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber, debugLog: boolean): Promise<BigNumber>;
}

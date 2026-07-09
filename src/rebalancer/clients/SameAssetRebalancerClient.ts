import {
  BigNumber,
  getTokenInfoFromSymbol,
  EvmAddress,
  isDefined,
  toBNWei,
  fromWei,
  getNetworkName,
  bnZero,
  assert,
  Address,
} from "../../utils";
import { BaseRebalancerClient } from "./BaseRebalancerClient";
import { InventoryClient, Rebalance } from "../../clients";
import { RebalanceRoute } from "../utils/interfaces";

type RebalanceWithAmount = RebalanceRoute & { amount: BigNumber };
type L2Withdrawal = { l2Token: Address; amountToWithdraw: BigNumber };

export class SameAssetRebalancerClient extends BaseRebalancerClient {
  override async rebalanceInventory(inventoryClient: InventoryClient, maxFeePct: BigNumber): Promise<void> {
    // Assert invariants:

    // Every rebalance route we have is between L1 and some L2 chain and is set in the RebalancerConfig
    for (const route of this.rebalanceRoutes) {
      if (
        !(
          (route.sourceChain === this.config.hubPoolChainId && route.destinationChain !== this.config.hubPoolChainId) ||
          (route.sourceChain !== this.config.hubPoolChainId && route.destinationChain === this.config.hubPoolChainId)
        )
      ) {
        throw new Error(
          `Rebalance route ${route.sourceChain} to ${route.destinationChain} is not between L1 and some L2 chain`
        );
      }
      assert(
        route.sourceToken === route.destinationToken,
        `Rebalance route ${route.sourceChain} to ${route.destinationChain} has different source and destination tokens`
      );
      if (
        !this.config.sameAssetBalances[route.sourceToken]?.[route.destinationChain] ||
        !this.config.sameAssetBalances[route.sourceToken]?.[route.sourceChain]
      ) {
        throw new Error(
          `Rebalance route ${route.sourceChain} to ${route.destinationChain} is not configured in RebalancerConfig for token ${route.sourceToken}`
        );
      }
    }

    // Get list of rebalances to execute from InventoryClient:
    // - rebalanceInventoryIfNeeded()
    // - withdrawExcessInventory()
    const _l1ToL2Rebalances = await inventoryClient.rebalanceInventoryIfNeeded(true);
    const _l2ToL1Withdrawals = await inventoryClient.withdrawExcessBalances(true);

    // Filter out rebalances to only those we have rebalance routes for.
    const l1ToL2Rebalances: RebalanceWithAmount[] = _l1ToL2Rebalances.flatMap((rebalance) => {
      const route = this.routeForL1ToL2Rebalance(rebalance);
      return route ? [{ ...route, amount: rebalance.amount }] : [];
    });
    const l2ToL1Withdrawals: RebalanceWithAmount[] = Object.entries(_l2ToL1Withdrawals).flatMap(
      ([chainId, withdrawals]) =>
        withdrawals.flatMap((withdrawal) => {
          const route = this.routeForL2ToL1Withdrawal(Number(chainId), withdrawal);
          return route ? [{ ...route, amount: withdrawal.amountToWithdraw }] : [];
        })
    );

    for (const rebalance of l1ToL2Rebalances.concat(l2ToL1Withdrawals)) {
      const availableAdapters = await this.getAvailableAdapters();
      if (!availableAdapters.includes(rebalance.adapter)) {
        this.logger.debug({
          at: "SameAssetRebalancerClient.rebalanceInventory",
          message: `Adapter ${rebalance.adapter} is not available; trying next route`,
          route: rebalance,
        });
        continue;
      }

      const { sourceToken, destinationToken, sourceChain, destinationChain, amount } = rebalance;
      const maxAmountToTransfer = this.config.maxAmountsToTransfer[sourceToken]?.[sourceChain];
      const amountToTransferCapped =
        isDefined(maxAmountToTransfer) && amount.gt(maxAmountToTransfer) ? maxAmountToTransfer : amount;
      const maxFee = amountToTransferCapped.mul(maxFeePct).div(toBNWei(100));
      const estimatedCost = await this.adapters[rebalance.adapter].getEstimatedCost(
        rebalance,
        amountToTransferCapped,
        false /* debugLog set to false because the logs would be really noisy, though detailed about how each estimated cost was computed */
      );
      if (estimatedCost.gt(maxFee)) {
        this.logger.debug({
          at: "SameAssetRebalancerClient.rebalanceInventory",
          message: `Estimated cost of ${estimatedCost.toString()} is greater than max fee of ${maxFee.toString()}`,
        });
        continue;
      }

      const l1TokenInfo = getTokenInfoFromSymbol(sourceToken, sourceChain);
      this.logger.debug({
        at: "SameAssetRebalancerClient.rebalanceInventory",
        message: `Initializing new ${rebalance.adapter} ${fromWei(amountToTransferCapped, l1TokenInfo.decimals)} ${sourceToken} rebalance from ${getNetworkName(sourceChain)} to ${getNetworkName(destinationChain)} ${destinationToken}`,
        adapter: rebalance.adapter,
        expectedFees: fromWei(estimatedCost, l1TokenInfo.decimals),
      });

      if (this.config.sendingTransactionsEnabled) {
        const initializedAmount = await this.adapters[rebalance.adapter].initializeRebalance(
          rebalance,
          amountToTransferCapped
        );
        if (initializedAmount.eq(bnZero)) {
          this.logger.debug({
            at: "SameAssetRebalancerClient.rebalanceInventory",
            message: `Adapter ${rebalance.adapter} declined to initialize rebalance; trying next route`,
            route: rebalance,
            requestedAmountToTransfer: amountToTransferCapped.toString(),
          });
          continue;
        }
      }
    }
  }

  private routeForL1ToL2Rebalance(rebalance: Rebalance): RebalanceRoute | undefined {
    return this.rebalanceRoutes.find((route) => {
      const l1Token = EvmAddress.from(
        getTokenInfoFromSymbol(route.sourceToken, this.config.hubPoolChainId).address.toNative()
      );
      const l2Token = getTokenInfoFromSymbol(route.destinationToken, route.destinationChain);
      return (
        route.sourceChain === this.config.hubPoolChainId &&
        route.destinationChain === rebalance.chainId &&
        l1Token.eq(rebalance.l1Token) &&
        l2Token.address.eq(rebalance.l2Token)
      );
    });
  }

  private routeForL2ToL1Withdrawal(chainId: number, withdrawal: L2Withdrawal): RebalanceRoute | undefined {
    return this.rebalanceRoutes.find((route) => {
      const l2Token = getTokenInfoFromSymbol(route.sourceToken, route.sourceChain);
      return (
        route.sourceChain === chainId &&
        route.destinationChain === this.config.hubPoolChainId &&
        l2Token.address.eq(withdrawal.l2Token)
      );
    });
  }
}

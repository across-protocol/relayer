/**
 * @notice Feature light adapter that currently only supports tracking pending rebalances from CCTP contracts.
 * @dev In the future we will add support for sending new CCTP rebalances.
 */

import { RebalanceRoute } from "../utils/interfaces";
import { BaseAdapter } from "./baseAdapter";
import { bnZero, forEachAsync, BigNumber } from "../../utils";

export class CctpAdapter extends BaseAdapter {
  async initialize(availableRoutes: RebalanceRoute[]): Promise<void> {
    await super.initialize(availableRoutes);
  }

  async initializeRebalance(): Promise<void> {
    throw new Error("Not implemented");
  }

  async updateRebalanceStatuses(): Promise<void> {
    // Does nothing.
    return;
  }

  async sweepIntermediateBalances(): Promise<void> {
    // Does nothing.
    return;
  }

  async getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }> {
    const pendingRebalances: { [chainId: number]: { [token: string]: BigNumber } } = {};
    const allChains = new Set<number>([...this.allSourceChains, ...this.allDestinationChains]);
    await forEachAsync(Array.from(allChains), async (sourceChain) => {
      await forEachAsync(
        Array.from(allChains).filter((otherChainId) => otherChainId !== sourceChain),
        async (destinationChain) => {
          // @dev Temporarily filter out L1->L2 and L2->L1 rebalances because they will already be counted by the
          // AdapterManager and this function is designed to be used in conjunction with the AdapterManager
          // to pain a full picture of all pending rebalances.
          if (sourceChain === this.config.hubPoolChainId || destinationChain === this.config.hubPoolChainId) {
            return;
          }
          const pendingRebalanceAmount = await this._getUnfinalizedCctpBridgeAmount(sourceChain, destinationChain);
          if (pendingRebalanceAmount.gt(bnZero)) {
            pendingRebalances[destinationChain] ??= {};
            pendingRebalances[destinationChain]["USDC"] = (pendingRebalances[destinationChain]?.["USDC"] ?? bnZero).add(
              pendingRebalanceAmount
            );
          }
        }
      );
    });
    return pendingRebalances;
  }

  async getEstimatedCost(): Promise<BigNumber> {
    throw new Error("Not implemented");
  }

  async getPendingOrders(): Promise<string[]> {
    return [];
  }

  protected _redisGetOrderStatusKey(): string {
    throw new Error("Not implemented");
  }
}

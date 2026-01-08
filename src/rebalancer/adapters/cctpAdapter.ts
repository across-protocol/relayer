/**
 * @notice Feature light adapter that currently only supports tracking pending rebalances from CCTP contracts.
 * @dev In the future we will add support for sending new CCTP rebalances.
 */

import { BigNumber } from "ethers";
import { RebalanceRoute } from "../rebalancer";
import { BaseAdapter } from "./baseAdapter";
import { bnZero, forEachAsync } from "../../utils";

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

  async getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }> {
    const pendingRebalances: { [chainId: number]: { [token: string]: BigNumber } } = {};
    const allChains = new Set<number>([...this.allSourceChains, ...this.allDestinationChains]);
    await forEachAsync(Array.from(allChains), async (sourceChain) => {
      await forEachAsync(
        Array.from(allChains).filter((otherChainId) => otherChainId !== sourceChain),
        async (destinationChain) => {
          pendingRebalances[destinationChain] ??= {};
          const pendingRebalanceAmount = await this._getUnfinalizedCctpBridgeAmount(sourceChain, destinationChain);
          if (pendingRebalanceAmount.gt(bnZero)) {
            this.logger.debug({
              at: "CctpAdapter.getPendingRebalances",
              message: `Adding ${pendingRebalanceAmount.toString()} USDC for pending rebalances from ${sourceChain} to ${destinationChain}`,
            });
          }
          pendingRebalances[destinationChain].USDC = (pendingRebalances[destinationChain]?.USDC ?? bnZero).add(
            pendingRebalanceAmount
          );
        }
      );
    });
    return pendingRebalances;
  }

  async getEstimatedCost(): Promise<BigNumber> {
    throw new Error("Not implemented");
  }

  protected _redisGetOrderStatusKey(): string {
    throw new Error("Not implemented");
  }
}

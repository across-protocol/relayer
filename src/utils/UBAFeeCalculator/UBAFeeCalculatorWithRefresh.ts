import { BigNumber } from "ethers";
import { Logger } from "winston";
import { UBAFeeCalculator, UBAFeeResult, UBAFlowRange, UBASpokeBalanceType } from ".";
import { SpokePoolClient } from "../../clients";
import { UbaFlow } from "../../interfaces";
import UBAConfig from "./UBAFeeConfig";

// This file holds the UBA Fee Calculator class with refresh. The goal of this class modify the UBA Fee Calculator class
// by adding the ability to refresh the running balance of the spoke pool. This is done by fetching the most recent
// confirmed bundle to the `blockNumber` and computing all the inflows and outflows to find the running balance.
// This is a convenience class that can be used to refresh the running balance of the spoke pool without having to
// create a new instance of the UBAFeeCalculator class every time.

/**
 * @file UBAFeeCalculatorWithRefresh.ts
 * @description UBA Fee Calculator with Refresh by use of two spoke pool clients
 * @author Across Bots Team
 */
export default class UBAFeeCalculatorWithRefresh extends UBAFeeCalculator {
  private originSpokeClient: SpokePoolClient;
  private destinationSpokeClient: SpokePoolClient;

  constructor(
    config: UBAConfig,
    logger: Logger,
    originSpokeClient: SpokePoolClient,
    destinationSpokeClient: SpokePoolClient
  ) {
    super(config, logger, undefined, undefined);
    this.originSpokeClient = originSpokeClient;
    this.destinationSpokeClient = destinationSpokeClient;
  }

  /**
   * @description Recalculates the running balance by fetching the most recent confirmed bundle to the `blockNumber` and computing all the inflows and outflows to find the running balance.
   * @param blockNumber An optional block number to act as the current time. If not provided, the current block number will be used. The block number is used to calculate the running balance from the most recent proposed bundle.
   */
  public async updateRunningBalance(blockNumber?: number): Promise<void> {
    const fn = async (spokeClient: SpokePoolClient, spoke: UBASpokeBalanceType) => {
      // Initially set the blockNumber to a new block with either the given input or the last blockNumber available
      spoke.blockNumber = blockNumber ?? (await spokeClient.spokePool.getBlockNumber());
      // Clear the recent request flow
      spoke.recentRequestFlow = [];
      // Resolve the most recent flows
      spoke.recentRequestFlow = await this.getRecentRequestFlow();
      // Recalculate the last validated running balance
      spoke.lastValidatedRunningBalance = await this.getLastValidatedBundleRunningBalance();
    };
    // Call the function for both the origin and destination spoke
    await fn(this.originSpokeClient, this.originSpoke);
    await fn(this.destinationSpokeClient, this.destinationSpoke);
  }

  public async getUBAFee(amount: BigNumber, flowRange?: UBAFlowRange): Promise<UBAFeeResult> {
    // First verify that both the last validated running balance and the runningBalance is
    // set to a non-undefined value
    if (
      super.destinationSpoke?.lastValidatedRunningBalance === undefined ||
      this.originSpoke?.lastValidatedRunningBalance === undefined
    ) {
      await this.updateRunningBalance();
    }
    // Call the super class getUBAFee function
    return super.getUBAFee(amount, flowRange);
  }

  // THE FOLLOWING FUNCTIONS BELOW WILL BE REMOVED BY THE CODE WRITTEN BY @pxrl

  /**
   * @description Get the most recent request flow array from the most recent validated propsoal block
   * @returns Promise<UbaFlow[]>
   * @todo Implement this function
   * @private
   * @async
   * @method getRecentRequestFlow
   * @memberof UBAFeeCalculator
   */
  private async getRecentRequestFlow(): Promise<UbaFlow[]> {
    throw new Error("Not implemented");
  }
  /**
   * @description Calculate the last validated running balance
   * @returns Promise<BigNumber>
   * @todo Implement this function
   * @private
   * @async
   * @method getLastValidatedBundleRunningBalance
   * @memberof UBAFeeCalculator
   * @returns {BigNumber}
   */
  private async getLastValidatedBundleRunningBalance(): Promise<BigNumber> {
    throw new Error("Not implemented");
  }
}

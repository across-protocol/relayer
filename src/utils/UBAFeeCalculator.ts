import { BigNumber } from "ethers";
import { UbaFlow, UbaRunningRequest, isUbaInflow, isUbaOutflow } from "../interfaces";
import { toBN } from "./FormattingUtils";
import { SpokePoolClient } from "../clients";
import { Logger } from "winston";

// This file holds the UBA Fee Calculator class. The goal of this class is to keep track
// of the running balance of a given spoke pool by fetching the most recent confirmed bundle
// and computing the inflows and outflows to find the running balance.
// The class can use this running balance to calculate the fee for a given action (request or refund)
//
// Example:
// const feeCalculator = new UBAFeeCalculator(provider, 123456);
// await feeCalculator.updateRunningBalance(); // <- This will fetch the most recent confirmed bundle and compute the running balance
// const fee1 = await feeCalculator.getUBAFee({ amount: toBN(100), type: "deposit" }); // <- This will calculate the fee for a given action while taking into account the running balance ( will not fetch the most recent confirmed bundle )
// console.log(fee1.toString());
// await feeCalculator.updateRunningBalance(); // <- This will fetch the most recent confirmed bundle and compute the running balance
// const fee2 = await feeCalculator.getUBAFee({ amount: toBN(100), type: "withdraw" }); // <- This will calculate the fee for a given action while taking into account the running balance ( will not fetch the most recent confirmed bundle )
// console.log(fee2.toString());
// const fee3 = await feeCalculator.getUBAFee({ amount: toBN(100), type: "deposit" }); // <- This will calculate the fee for a given action while taking into account the running balance ( will not fetch the most recent confirmed bundle )
// console.log(fee3.toString());

/**
 * @file UBAFeeCalculator.ts
 * @description UBA Fee Calculator
 * @author Across Bots Team
 */
export default class UBAFeeCalculator {
  private readonly spokeClient: SpokePoolClient;
  private readonly logger: Logger;
  private blockNumber: number;
  private lastValidatedRunningBalance?: BigNumber;
  private recentRequestFlow: UbaFlow[];
  private runningBalance?: BigNumber;

  constructor(spokeClient: SpokePoolClient, logger: Logger, initialBlockNumber: number) {
    this.spokeClient = spokeClient;
    this.blockNumber = initialBlockNumber;
    this.logger = logger;
  }

  /**
   * @description Recalculates the running balance by fetching the most recent confirmed bundle to the `blockNumber` and computing all the inflows and outflows to find the running balance.
   * @param blockNumber An optional block number to act as the current time. If not provided, the current block number will be used. The block number is used to calculate the running balance from the most recent proposed bundle.
   */
  public async updateRunningBalance(blockNumber?: number): Promise<void> {
    // Initially set the blockNumber to a new block with either the given input or the last blockNumber available
    this.blockNumber = blockNumber ?? (await this.spokeClient.spokePool.getBlockNumber());
    // Clear the recent request flow
    this.recentRequestFlow = [];
    // Resolve the most recent flows
    this.recentRequestFlow = await this.getRecentRequestFlow();
    // Recalculate the last validated running balance
    this.lastValidatedRunningBalance = await this.getLastValidatedBundleRunningBalance();
    // Resolve the running balance
    this.runningBalance = this.calculateRecentRunningBalance();
  }

  /**
   * @description Get the recent request flow
   * @param action The action to get the fee for
   * @param tokenSymbol The token symbol to get the fee for
   * @returns The relevant fee
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async getUBAFee(action: UbaRunningRequest, tokenSymbol: string): Promise<BigNumber> {
    // Destructure the action
    const { amount, type } = action;
    // First verify that both the last validated running balance and the runningBalance is
    // set to a non-undefined value
    if (this.lastValidatedRunningBalance === undefined || this.runningBalance === undefined) {
      await this.updateRunningBalance();
    }
    // Set the amount to add to the running balance
    const amountToModify = amount.mul(type === "deposit" ? 1 : -1);
    // Resolve the new modified balance
    const modifiedBalance = this.runningBalance.add(amountToModify);
    // Return the running balance
    // TODO: Add the fee calculation
    return modifiedBalance;
  }

  /**
   * @description Get the running balance
   * @returns Promise<BigNumber>
   * @private
   * @method calculateRecentRunningBalance
   * @memberof UBAFeeCalculator
   */
  private calculateRecentRunningBalance(): BigNumber {
    // Reduce over the recent request flow and add the amount to
    // the last validated running balance. If there is no last validated running balance
    // then set the initial value to 0
    return this.recentRequestFlow.reduce((acc, flow) => {
      if (isUbaInflow(flow)) {
        return acc.add(toBN(flow.amount));
      } else if (isUbaOutflow(flow)) {
        return acc.sub(toBN(flow.amount));
      }
    }, this.lastValidatedRunningBalance ?? toBN(0));
  }

  /**
   * @description Get the most recent request flow
   * @returns Promise<UbaFlow[]>
   * @todo Implement this function
   * @private
   * @async
   * @method getRecentRequestFlow
   * @memberof UBAFeeCalculator
   */
  private async getRecentRequestFlow(): Promise<UbaFlow[]> {
    this.blockNumber;
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
    this.blockNumber;
    throw new Error("Not implemented");
  }
}

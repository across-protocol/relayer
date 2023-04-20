import { BigNumber } from "ethers";
import { UbaFlow, UbaRunningRequest, isUbaInflow, isUbaOutflow } from "../../interfaces";
import { toBN } from "../FormattingUtils";
import { Logger } from "winston";
import UBAConfig from "./UBAFeeConfig";
import { getDepositBalancingFee, getRefundBalancingFee } from "./UBAFeeUtility";
import { UBASpokeBalanceType } from ".";

// This file holds the UBA Fee Calculator class. The goal of this class is to keep track
// of the running balance of a given spoke pool by fetching the most recent confirmed bundle
// and computing the inflows and outflows to find the running balance.
// The class can use this running balance to calculate the fee for a given action (request or refund)

/**
 * @file UBAFeeCalculator.ts
 * @description UBA Fee Calculator
 * @author Across Bots Team
 */
export default class UBAFeeCalculator {
  private readonly logger: Logger;
  private readonly config: UBAConfig;
  protected readonly originSpoke: UBASpokeBalanceType;
  protected readonly destinationSpoke: UBASpokeBalanceType;

  constructor(
    config: UBAConfig,
    logger: Logger,
    originSpoke: UBASpokeBalanceType,
    destinationSpoke: UBASpokeBalanceType
  ) {
    this.config = config;
    this.logger = logger;
    this.originSpoke = originSpoke;
    this.destinationSpoke = destinationSpoke;
  }

  /**
   * @description Get the recent request flow
   * @param action The action to get the fee for
   * @param tokenSymbol The token symbol to get the fee for
   * @returns The relevant fee
   */
  public async getUBAFee(action: UbaRunningRequest): Promise<BigNumber> {
    // Destructure the action
    const { amount, type } = action;
    // Get the origin and destination chain ids
    const originChain = this.originSpoke.chainId;
    const destinationChain = this.destinationSpoke.chainId;
    // Resolve the alpha fee of this action
    const alphaFee = this.config.getBaselineFee(originChain, destinationChain);
    // Resolve the utilization fee
    const utilizationFee = this.config.getUtilizationFee();

    let totalUBAFee = alphaFee.add(utilizationFee);
    // Resolve the balancing fee tuples that are relevant to this operation
    const originBalancingFeeTuples = this.config.getBalancingFeeTuples(originChain);
    const destinationBalancingFeeTuples = this.config.getBalancingFeeTuples(destinationChain);

    // If the action is a deposit, then we need to add the origin and destination balancing fee
    // to the total UBA fee. We can use the getDepositBalancingFee function to do this
    // Find both of these fees from the origin and destination chains
    if (type === "deposit") {
      totalUBAFee = totalUBAFee.add(
        getDepositBalancingFee(originBalancingFeeTuples, this.originSpoke.runningBalance, amount)
      );
      totalUBAFee = totalUBAFee.add(
        getRefundBalancingFee(destinationBalancingFeeTuples, this.destinationSpoke.runningBalance, amount)
      );
    }
    // If the action is a refund, then we need to add the origin and destination balancing fee
    // to the total UBA fee. We can use the getRefundBalancingFee function to do this
    // Find both of these fees from the origin and destination chains
    else {
      totalUBAFee = totalUBAFee.add(
        getRefundBalancingFee(originBalancingFeeTuples, this.originSpoke.runningBalance, amount)
      );
      totalUBAFee = totalUBAFee.add(
        getDepositBalancingFee(destinationBalancingFeeTuples, this.destinationSpoke.runningBalance, amount)
      );
    }

    return totalUBAFee;
  }

  /**
   * @description Get the running balance
   * @returns void
   * @protected
   * @method calculateRecentRunningBalance
   * @memberof UBAFeeCalculator
   */
  protected calculateRecentRunningBalance(): void {
    // Reduce over the recent request flow and add the amount to
    // the last validated running balance. If there is no last validated running balance
    // then set the initial value to 0
    const fn = (flow: UbaFlow[], validatedRunningBalance?: BigNumber) =>
      flow.reduce((acc, flow) => {
        if (isUbaInflow(flow)) {
          return acc.add(toBN(flow.amount));
        } else if (isUbaOutflow(flow)) {
          return acc.sub(toBN(flow.amount));
        }
      }, validatedRunningBalance ?? toBN(0));
    this.originSpoke.runningBalance = fn(
      this.originSpoke.recentRequestFlow,
      this.originSpoke.lastValidatedRunningBalance
    );
    this.destinationSpoke.runningBalance = fn(
      this.destinationSpoke.recentRequestFlow,
      this.destinationSpoke.lastValidatedRunningBalance
    );
  }
}

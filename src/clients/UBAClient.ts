import winston from "winston";
import { BigNumber } from "ethers";
import { clients, relayFeeCalculator } from "@across-protocol/sdk-v2";
import { UBABalancingFee } from "../interfaces";
import { HubPoolClient } from "./HubPoolClient";
import { SpokePoolClient } from "./SpokePoolClient";

// @dev ts is unhappy that UBAActionType is used as a type and an object.
const { UBAActionType } = clients;
type UBAActionType = clients.UBAActionType;

type RelayFeeCalculatorConfig = relayFeeCalculator.RelayFeeCalculatorConfig;

export class UBAClient extends clients.UBAClient {
  constructor(
    chainIdIndices: number[],
    hubPoolClient: HubPoolClient,
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    logger: winston.Logger
  ) {
    super(chainIdIndices, hubPoolClient, spokePoolClients, {} as RelayFeeCalculatorConfig, logger);
  }

  // XXX This is copy/pasted from sdk-v2 because we seem to be clobbering the abstract definitions! @todo: fix.
  /**
   * Calculate the balancing fee of a given token on a given chainId at a given block number
   * @param spokePoolToken The token to get the balancing fee for
   * @param amount The amount to get the balancing fee for
   * @param hubPoolBlockNumber The block number to get the balancing fee for
   * @param chainId The chainId to get the balancing fee for. If the feeType is Deposit, this is the deposit chainId. If the feeType is Refund, this is the refund chainId.
   * @param feeType The type of fee to calculate
   * @returns The balancing fee for the given token on the given chainId at the given block number
   */
  public async computeBalancingFee(
    spokePoolToken: string,
    amount: BigNumber,
    hubPoolBlockNumber: number,
    chainId: number,
    feeType: UBAActionType
  ): Promise<UBABalancingFee> {
    // Verify that the spoke clients are instantiated.
    await this.instantiateUBAFeeCalculator(chainId, spokePoolToken, hubPoolBlockNumber);
    // Get the balancing fees.
    const { balancingFee } =
      this.spokeUBAFeeCalculators[chainId][spokePoolToken][
        feeType === UBAActionType.Deposit ? "getDepositFee" : "getRefundFee"
      ](amount);
    return {
      balancingFee,
      actionType: feeType,
    };
  }
}

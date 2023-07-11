import winston from "winston";
import { clients, relayFeeCalculator } from "@across-protocol/sdk-v2";
import { HubPoolClient } from "./HubPoolClient";
import { SpokePoolClient } from "./SpokePoolClient";

type RelayFeeCalculatorConfig = relayFeeCalculator.RelayFeeCalculatorConfig;

export class UBAClient extends clients.UBAClient {
  constructor(
    chainIdIndices: number[],
    tokenSymbols: string[],
    hubPoolClient: HubPoolClient,
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    logger: winston.Logger,
    maxBundleStates = 1
  ) {
    super(
      chainIdIndices,
      tokenSymbols,
      hubPoolClient,
      spokePoolClients,
      {} as RelayFeeCalculatorConfig,
      maxBundleStates,
      logger
    );
  }
}

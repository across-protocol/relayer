import winston from "winston";
import { clients, relayFeeCalculator } from "@across-protocol/sdk-v2";
import { HubPoolClient } from "./HubPoolClient";
import { SpokePoolClient } from "./SpokePoolClient";

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
}

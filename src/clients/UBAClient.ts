import winston from "winston";
import { clients, relayFeeCalculator } from "@across-protocol/sdk-v2";
import { FillWithBlock, RefundRequestWithBlock } from "../interfaces";
import { HubPoolClient } from "./HubPoolClient";
import { SpokePoolClient } from "./SpokePoolClient";

const { getFills, getRefundRequests } = clients;
type SpokePoolEventFilter = clients.SpokePoolEventFilter;
type SpokePoolFillFilter = clients.SpokePoolFillFilter;

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

  async getFills(chainId: number, filter: SpokePoolFillFilter = {}): Promise<FillWithBlock[]> {
    return getFills(chainId, this.spokePoolClients, filter);
  }

  async getRefundRequests(chainId: number, filter: SpokePoolEventFilter = {}): Promise<RefundRequestWithBlock[]> {
    return getRefundRequests(chainId, this.chainIdIndices, this.hubPoolClient, this.spokePoolClients, filter);
  }
}

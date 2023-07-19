import winston from "winston";
import { clients } from "@across-protocol/sdk-v2";
import { FillWithBlock, RefundRequestWithBlock } from "../interfaces";
import { HubPoolClient } from "./HubPoolClient";
import { SpokePoolClient } from "./SpokePoolClient";

const { getFills, getRefundRequests } = clients;
type SpokePoolEventFilter = clients.SpokePoolEventFilter;
type SpokePoolFillFilter = clients.SpokePoolFillFilter;

export class UBAClient extends clients.UBAClient {
  constructor(
    chainIdIndices: number[],
    tokenSymbols: string[],
    hubPoolClient: HubPoolClient,
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    logger: winston.Logger,
    maxBundleStates = 1
  ) {
    super(chainIdIndices, tokenSymbols, hubPoolClient, spokePoolClients, maxBundleStates, logger);
  }

  async getFills(chainId: number, filter: SpokePoolFillFilter = {}): Promise<FillWithBlock[]> {
    return getFills(chainId, this.hubPoolClient, this.spokePoolClients, filter);
  }

  async getRefundRequests(chainId: number, filter: SpokePoolEventFilter = {}): Promise<RefundRequestWithBlock[]> {
    return getRefundRequests(chainId, this.hubPoolClient, this.spokePoolClients, filter);
  }
}

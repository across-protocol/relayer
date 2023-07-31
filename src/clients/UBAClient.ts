import { clients } from "@across-protocol/sdk-v2";
import { FillWithBlock, RefundRequestWithBlock } from "../interfaces";
import { HubPoolClient } from "./HubPoolClient";
import { SpokePoolClient } from "./SpokePoolClient";

const { getValidFillCandidates, getValidRefundCandidates } = clients;
type SpokePoolFillFilter = clients.SpokePoolFillFilter;

export class UBAClient extends clients.UBAClient {
  constructor(
    tokenSymbols: string[],
    hubPoolClient: HubPoolClient,
    spokePoolClients: { [chainId: number]: SpokePoolClient }
  ) {
    super(tokenSymbols, hubPoolClient, spokePoolClients);
  }

  async getFills(chainId: number, filter: SpokePoolFillFilter = {}): Promise<FillWithBlock[]> {
    return getValidFillCandidates(chainId, this.spokePoolClients, filter);
  }

  async getRefundRequests(chainId: number, filter: SpokePoolFillFilter = {}): Promise<RefundRequestWithBlock[]> {
    return getValidRefundCandidates(chainId, this.hubPoolClient, this.spokePoolClients, filter);
  }
}

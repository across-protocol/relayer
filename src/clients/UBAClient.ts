import { clients, interfaces } from "@across-protocol/sdk-v2";
import { FillWithBlock } from "../interfaces";
import { HubPoolClient } from "./HubPoolClient";
import { SpokePoolClient } from "./SpokePoolClient";

const { getValidFillCandidates } = clients;
type SpokePoolFillFilter = clients.SpokePoolFillFilter;

export class UBAClient extends clients.UBAClient {
  constructor(
    clientConfig: clients.UBAClientConfig,
    tokenSymbols: string[],
    hubPoolClient: HubPoolClient,
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    cachingMechanism?: interfaces.CachingMechanismInterface
  ) {
    super(clientConfig, tokenSymbols, hubPoolClient, spokePoolClients, cachingMechanism);
  }

  async getFills(chainId: number, filter: SpokePoolFillFilter = {}): Promise<FillWithBlock[]> {
    return getValidFillCandidates(chainId, this.spokePoolClients, filter);
  }
}

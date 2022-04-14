import { SpokePoolClient, HubPoolClient, RateModelClient, MultiCallerClient } from ".";

export interface Clients {
  spokePoolClients: { [chainId: number]: SpokePoolClient };
  hubPoolClient: HubPoolClient;
  rateModelClient: RateModelClient;
  multiCallerClient: MultiCallerClient;
}

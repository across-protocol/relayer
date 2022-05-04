import { SpokePoolClient, HubPoolClient, AcrossConfigStoreClient, MultiCallerClient } from ".";

export interface Clients {
  spokePoolClients: { [chainId: number]: SpokePoolClient };
  hubPoolClient: HubPoolClient;
  configStoreClient: AcrossConfigStoreClient;
  multiCallerClient: MultiCallerClient;
}

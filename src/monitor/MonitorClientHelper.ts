import { MonitorConfig } from "./MonitorConfig";
import { getSigner, winston } from "../utils";
import { HubPoolClient } from "../clients";
import {
  Clients,
  updateClients,
  updateSpokePoolClients,
  constructClients,
  constructSpokePoolClientsWithLookback,
} from "../common";
import { SpokePoolClientsByChain } from "../interfaces";

export interface MonitorClients extends Clients {
  hubPoolClient: HubPoolClient;
  spokePoolClients: SpokePoolClientsByChain;
}

export async function constructMonitorClients(config: MonitorConfig, logger: winston.Logger): Promise<MonitorClients> {
  const baseSigner = await getSigner(); // todo: add getVoidSigner
  const commonClients = await constructClients(logger, config);
  const spokePoolClients = await constructSpokePoolClientsWithLookback(
    logger,
    commonClients.configStoreClient,
    config,
    baseSigner
  );

  return { ...commonClients, spokePoolClients };
}

export async function updateMonitorClients(clients: MonitorClients) {
  await updateClients(clients);
  // SpokePoolClient client requires up to date HubPoolClient and ConfigStore client.
  await updateSpokePoolClients(clients.spokePoolClients);
}

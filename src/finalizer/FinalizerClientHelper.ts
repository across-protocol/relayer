import winston from "winston";
import { getSigner } from "../utils";
import { SpokePoolClient } from "../clients";
import { Clients, constructClients, updateClients, updateSpokePoolClients } from "../common";
import { constructSpokePoolClientsWithLookback } from "../common/ClientHelper";
import { FinalizerConfig } from "./FinalizerConfig";

export interface FinalizerClients extends Clients {
  spokePoolClients: { [chainId: number]: SpokePoolClient };
}

export async function constructFinalizerClients(
  logger: winston.Logger,
  config: FinalizerConfig
): Promise<FinalizerClients> {
  const baseSigner = await getSigner();

  const commonClients = await constructClients(logger, config);

  const spokePoolClients = await constructSpokePoolClientsWithLookback(logger, commonClients, config, baseSigner);

  return { ...commonClients, spokePoolClients };
}

export async function updateFinalizerClients(clients: FinalizerClients) {
  await updateClients(clients);
  // SpokePoolClient client requires up to date HubPoolClient and ConfigStore client.
  await updateSpokePoolClients(clients.spokePoolClients);
}

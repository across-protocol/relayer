import winston from "winston";
import { DataworkerConfig } from "./DataworkerConfig";
import { Clients, constructClients, updateClients } from "../common";

export interface DataworkerClients extends Clients {}

export async function constructDataworkerClients(
  logger: winston.Logger,
  config: DataworkerConfig
): Promise<DataworkerClients> {
  const commonClients = await constructClients(logger, config);

  return { ...commonClients };
}

export async function updateDataworkerClients(logger: winston.Logger, clients: DataworkerClients) {
  await updateClients(logger, clients);
}

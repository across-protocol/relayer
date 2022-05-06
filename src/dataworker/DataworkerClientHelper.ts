import winston from "winston";
import { DataworkerConfig } from "./DataworkerConfig";
import { Clients, constructClients, getSpokePoolSigners, updateClients } from "../common";
import { EventSearchConfig, getDeploymentBlockNumber, getSigner, Wallet } from "../utils";

export interface DataworkerClients extends Clients {
  spokePoolSigners: { [chainId: number]: Wallet };
  spokePoolClientSearchSettings: { [chainId: number]: EventSearchConfig };
}

export async function constructDataworkerClients(
  logger: winston.Logger,
  config: DataworkerConfig
): Promise<DataworkerClients> {
  const commonClients = await constructClients(logger, config);
  const baseSigner = await getSigner();
  const spokePoolSigners = getSpokePoolSigners(baseSigner, config);
  const spokePoolClientSearchSettings = Object.fromEntries(
    config.spokePoolChains.map((chainId) => {
      return [
        chainId,
        {
          fromBlock: Number(getDeploymentBlockNumber("SpokePool", chainId)),
          toBlock: null,
          maxBlockLookBack: config.maxBlockLookBack[chainId],
        },
      ];
    })
  );

  return { ...commonClients, spokePoolSigners, spokePoolClientSearchSettings };
}

export async function updateDataworkerClients(clients: DataworkerClients) {
  await updateClients(clients);
}

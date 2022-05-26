import { SpokePool } from "@across-protocol/contracts-v2";
import { MonitorConfig } from "../monitor/MonitorConfig";
import { getDeployedContract, winston, getSigner } from "../utils";
import { HubPoolClient } from "./HubPoolClient";
import { constructClients, getSpokePoolSigners } from "../common";

export interface MonitorClients {
  hubPoolClient: HubPoolClient;
  spokePools: { [chainId: number]: SpokePool };
}

export async function constructMonitorClients(config: MonitorConfig, logger: winston.Logger): Promise<MonitorClients> {
  const baseSigner = await getSigner(); // todo: add getVoidSigner

  const spokePoolSigners = getSpokePoolSigners(baseSigner, config);

  const commonClients = await constructClients(logger, config);
  const spokePools = config.spokePoolChains.reduce((acc, chainId) => {
    return {
      ...acc,
      [chainId]: getDeployedContract("SpokePool", chainId, spokePoolSigners[chainId]) as SpokePool,
    };
  }, {} as Record<number, SpokePool>);

  return { ...commonClients, spokePools };
}

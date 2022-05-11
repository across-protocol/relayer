import { SpokePool } from "@across-protocol/contracts-v2";
import { MonitorConfig } from "../monitor/MonitorConfig";
import { getDeployedContract, winston } from "../utils";
import { HubPoolClient } from "./HubPoolClient";

export interface MonitorClients {
  hubPoolClient: HubPoolClient;
  spokePools: { [chainId: number]: SpokePool };
}

export function constructMonitorClients(config: MonitorConfig, logger: winston.Logger): MonitorClients {
  const hubPool = getDeployedContract("HubPool", config.hubPoolChainId);
  const hubPoolClient = new HubPoolClient(logger, hubPool);
  const spokePools = config.spokePoolChains.reduce((acc, chainId) => {
    return {
      ...acc,
      [chainId]: getDeployedContract("SpokePool", chainId) as SpokePool,
    };
  }, {} as Record<number, SpokePool>);

  return { hubPoolClient, spokePools };
}

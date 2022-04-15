import { SpokePool } from "@across-protocol/contracts-v2";
import { MonitorConfig } from "../monitor/MonitorConfig";
import { getDeployedContract, getProvider, getSigner, winston } from "../utils";
import { HubPoolClient } from "./HubPoolClient";

export interface MonitorClients {
  hubPoolClient: HubPoolClient;
  spokePools: { [chainId: number]: SpokePool };
}

export function constructMonitorClients(config: MonitorConfig, logger: winston.Logger): MonitorClients {
  const baseSigner = getSigner();
  const l1Provider = getProvider(config.hubPoolChainId);
  const hubSigner = baseSigner.connect(l1Provider);
  const hubPool = getDeployedContract("HubPool", config.hubPoolChainId, hubSigner);
  const hubPoolClient = new HubPoolClient(logger, hubPool);
  const spokeSigners = config.spokePoolChainIds
    .map((networkId) => getProvider(networkId))
    .map((provider) => baseSigner.connect(provider));
  const spokePools = config.spokePoolChainIds.reduce((acc, chainId, idx) => {
    return {
      ...acc,
      [chainId]: getDeployedContract("SpokePool", chainId, spokeSigners[idx]) as SpokePool,
    };
  }, {} as Record<number, SpokePool>);

  return { hubPoolClient, spokePools };
}

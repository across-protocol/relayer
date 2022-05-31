import { SpokePool } from "@across-protocol/contracts-v2";
import { MonitorConfig } from "../monitor/MonitorConfig";
import { getDeployedContract, getDeploymentBlockNumber, getSigner, winston } from "../utils";
import { HubPoolClient, SpokePoolClient } from "../clients";
import { constructClients, getSpokePoolSigners } from "../common";
import { CHAIN_MAX_BLOCK_LOOKBACK } from "../common";
import { SpokePoolClientsByChain } from "../interfaces";

export interface MonitorClients {
  hubPoolClient: HubPoolClient;
  spokePoolClients: SpokePoolClientsByChain;
}

export async function constructMonitorClients(config: MonitorConfig, logger: winston.Logger): Promise<MonitorClients> {
  const baseSigner = await getSigner(); // todo: add getVoidSigner

  const spokePoolSigners = getSpokePoolSigners(baseSigner, config);

  const commonClients = await constructClients(logger, config);
  const spokePoolClients = config.spokePoolChains.reduce((acc, chainId) => {
    const spokePool = getDeployedContract("SpokePool", chainId, spokePoolSigners[chainId]) as SpokePool;
    const startingBlock = Number(getDeploymentBlockNumber("SpokePool", chainId));
    const spokePoolClient = new SpokePoolClient(
      logger,
      spokePool,
      commonClients.configStoreClient,
      Number(chainId),
      {
        fromBlock: startingBlock,
        toBlock: null,
        maxBlockLookBack: CHAIN_MAX_BLOCK_LOOKBACK[chainId],
      },
      startingBlock
    );

    return {
      ...acc,
      [chainId]: spokePoolClient,
    };
  }, {} as Record<number, SpokePoolClient>);

  return { ...commonClients, spokePoolClients };
}

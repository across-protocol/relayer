import { clients } from "@across-protocol/sdk-v2";
import { Contract } from "ethers";
import winston from "winston";
import { MakeOptional, EventSearchConfig } from "../utils";
import { IGNORED_HUB_EXECUTED_BUNDLES, IGNORED_HUB_PROPOSED_BUNDLES } from "../common";

export class HubPoolClient extends clients.HubPoolClient {
  constructor(
    logger: winston.Logger,
    hubPool: Contract,
    configStoreClient: clients.AcrossConfigStoreClient,
    deploymentBlock?: number,
    chainId = 1,
    eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 }
  ) {
    super(logger, hubPool, configStoreClient, deploymentBlock, chainId, eventSearchConfig, {
      ignoredHubExecutedBundles: IGNORED_HUB_EXECUTED_BUNDLES,
      ignoredHubProposedBundles: IGNORED_HUB_PROPOSED_BUNDLES,
    });
  }
}

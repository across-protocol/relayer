import { clients, interfaces } from "@across-protocol/sdk";
import { Contract } from "ethers";
import winston from "winston";
import { CHAIN_IDs, MakeOptional, EventSearchConfig } from "../utils";
import { IGNORED_HUB_EXECUTED_BUNDLES, IGNORED_HUB_PROPOSED_BUNDLES } from "../common";

export type LpFeeRequest = clients.LpFeeRequest;

export class HubPoolClient extends clients.HubPoolClient {
  constructor(
    logger: winston.Logger,
    hubPool: Contract,
    configStoreClient: clients.AcrossConfigStoreClient,
    deploymentBlock?: number,
    chainId = CHAIN_IDs.MAINNET,
    eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 },
    cachingMechanism?: interfaces.CachingMechanismInterface,
    timeToCache?: number
  ) {
    super(
      logger,
      hubPool,
      configStoreClient,
      deploymentBlock,
      chainId,
      eventSearchConfig,
      {
        ignoredHubExecutedBundles: IGNORED_HUB_EXECUTED_BUNDLES,
        ignoredHubProposedBundles: IGNORED_HUB_PROPOSED_BUNDLES,
        timeToCache,
      },
      cachingMechanism
    );
  }

  async computeRealizedLpFeePct(deposit: LpFeeRequest): Promise<interfaces.RealizedLpFee> {
    if (deposit.quoteTimestamp > this.currentTime) {
      throw new Error(
        `Cannot compute lp fee percent for quote timestamp ${deposit.quoteTimestamp} in the future. Current time: ${this.currentTime}.`
      );
    }

    return await super.computeRealizedLpFeePct(deposit);
  }
}

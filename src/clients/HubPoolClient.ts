import { clients } from "@across-protocol/sdk-v2";
import { Contract } from "ethers";
import winston from "winston";
import { MakeOptional, EventSearchConfig } from "../utils";
import { IGNORED_HUB_EXECUTED_BUNDLES, IGNORED_HUB_PROPOSED_BUNDLES } from "../common";
import { DepositWithBlock } from "../interfaces";

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

  async computeRealizedLpFeePct(
    deposit: Pick<
      DepositWithBlock,
      "quoteTimestamp" | "amount" | "destinationChainId" | "originChainId" | "blockNumber"
    >,
    l1Token: string
  ): Promise<{ realizedLpFeePct: BigNumber | undefined; quoteBlock: number }> {

    if (deposit.quoteTimestamp > this.currentTime) {
      throw new Error(
        `Cannot compute lp fee percent for quote timestamp ${deposit.quoteTimestamp} in the future. Current time: ${this.currentTime}.`
      );
    }

    return await super.computeRealizedLpFeePct(deposit, l1Token);
  }
}

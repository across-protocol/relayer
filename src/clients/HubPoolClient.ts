import { clients } from "@across-protocol/sdk-v2";
import { ConfigStoreClient } from "./";
import { Contract } from "ethers";
import { IGNORED_HUB_EXECUTED_BUNDLES, IGNORED_HUB_PROPOSED_BUNDLES } from "../common";
import { BigNumber, getRedis, shouldCache, getCurrentTime, setRedisKey, EventSearchConfig, MakeOptional, winston } from "../utils"

export class HubPoolClient extends clients.HubPoolClient {
  constructor(
    logger: winston.Logger,
    hubPool: Contract,
    configStoreClient: ConfigStoreClient,
    deploymentBlock?: number,
    chainId = 1,
    eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 }
  ) {
    super(logger, hubPool, configStoreClient, deploymentBlock, chainId, eventSearchConfig, {
      ignoredHubExecutedBundles: IGNORED_HUB_EXECUTED_BUNDLES,
      ignoredHubProposedBundles: IGNORED_HUB_PROPOSED_BUNDLES,
    });
  }

  protected async getUtilization(
    l1Token: string,
    blockNumber: number,
    amount: BigNumber,
    timestamp: number
  ): Promise<{ current: BigNumber; post: BigNumber }> {
    const redisClient = await getRedis(this.logger);
    if (!redisClient) {
      return await this.getPostRelayPoolUtilization(l1Token, blockNumber, amount);
    }
    const key = `utilization_${l1Token}_${blockNumber}_${amount.toString()}`;
    const result = await redisClient.get(key);
    if (result === null) {
      const { current, post } = await this.getPostRelayPoolUtilization(l1Token, blockNumber, amount);
      if (shouldCache(getCurrentTime(), timestamp)) {
        await setRedisKey(key, `${current.toString()},${post.toString()}`, redisClient, 60 * 60 * 24 * 90);
      }
      return { current, post };
    } else {
      const [current, post] = result.split(",").map(BigNumber.from);
      return { current, post };
    }
  }
}

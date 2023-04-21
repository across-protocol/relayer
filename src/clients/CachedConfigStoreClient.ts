import {
  BigNumber,
  getCurrentTime,
  shouldCache,
  setRedisKey,
  getRedis,
  Contract,
  EventSearchConfig,
  winston,
} from "../utils";

import { AcrossConfigStoreClient } from "../../../sdk-v2/src/clients/AcrossConfigStoreClient";
import { HubPoolClient } from "./HubPoolClient";

export class CachedAcrossConfigStoreClient extends AcrossConfigStoreClient {
  constructor(
    logger: winston.Logger,
    configStore: Contract,
    hubPoolClient: HubPoolClient,
    eventSearchConfig: EventSearchConfig
  ) {
    super(logger, configStore, hubPoolClient, eventSearchConfig);
  }

  protected async getUtilization(
    l1Token: string,
    blockNumber: number,
    amount: BigNumber,
    timestamp: number
  ): Promise<{ current: BigNumber; post: BigNumber }> {
    const redisClient = await getRedis(this.logger);
    if (!redisClient) {
      return super.getUtilization(l1Token, blockNumber, amount, timestamp);
    }
    const key = `utilization_${l1Token}_${blockNumber}_${amount.toString()}`;
    const result = await redisClient.get(key);
    if (result === null) {
      const { current, post } = await this.hubPoolClient.getPostRelayPoolUtilization(l1Token, blockNumber, amount);
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

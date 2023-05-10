import { clients } from "@across-protocol/sdk-v2";
import { BigNumber, Contract } from "ethers";
import { getRedis, shouldCache, getCurrentTime, setRedisKey, EventSearchConfig, MakeOptional, winston } from "../utils";
import { CHAIN_ID_LIST_INDICES, CONFIG_STORE_VERSION, DEFAULT_CONFIG_STORE_VERSION } from "../common";
import { HubPoolClient } from "./HubPoolClient";

export const GLOBAL_CONFIG_STORE_KEYS = clients.GLOBAL_CONFIG_STORE_KEYS;

export class AcrossConfigStoreClient extends clients.AcrossConfigStoreClient {
  constructor(
    logger: winston.Logger,
    configStore: Contract,
    hubPoolClient: HubPoolClient,
    eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 },
    enabledChainIds: number[] = CHAIN_ID_LIST_INDICES
  ) {
    super(logger, configStore, hubPoolClient, eventSearchConfig, {
      enabledChainIds,
      defaultConfigStoreVersion: DEFAULT_CONFIG_STORE_VERSION,
      configStoreVersion: CONFIG_STORE_VERSION,
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
      return await this.hubPoolClient.getPostRelayPoolUtilization(l1Token, blockNumber, amount);
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

import {
  spreadEvent,
  winston,
  Contract,
  BigNumber,
  sortEventsDescending,
  spreadEventWithBlockNumber,
  paginatedEventQuery,
  EventSearchConfig,
  utf8ToHex,
  getCurrentTime,
  toBN,
  min
} from "../utils";
import {
  L1TokenTransferThreshold,
  Deposit,
  TokenConfig,
  GlobalConfigUpdate,
  ParsedTokenConfig,
  SpokeTargetBalanceUpdate,
  SpokePoolTargetBalance,
} from "../interfaces";

import { lpFeeCalculator } from "@across-protocol/sdk-v2";
import { BlockFinder, across } from "@uma/sdk";
import { HubPoolClient } from "./HubPoolClient";
import { createClient } from "redis4";

export const GLOBAL_CONFIG_STORE_KEYS = {
  MAX_RELAYER_REPAYMENT_LEAF_SIZE: "MAX_RELAYER_REPAYMENT_LEAF_SIZE",
  MAX_POOL_REBALANCE_LEAF_SIZE: "MAX_POOL_REBALANCE_LEAF_SIZE",
};

export class AcrossConfigStoreClient {
  private readonly blockFinder;

  public cumulativeRateModelUpdates: across.rateModel.RateModelEvent[] = [];
  public cumulativeTokenTransferUpdates: L1TokenTransferThreshold[] = [];
  public cumulativeMaxRefundCountUpdates: GlobalConfigUpdate[] = [];
  public cumulativeMaxL1TokenCountUpdates: GlobalConfigUpdate[] = [];
  public cumulativeSpokeTargetBalanceUpdates: SpokeTargetBalanceUpdate[] = [];

  private rateModelDictionary: across.rateModel.RateModelDictionary;
  public firstBlockToSearch: number;

  public isUpdated = false;

  public client: ReturnType<typeof createClient>;

  constructor(
    readonly logger: winston.Logger,
    readonly configStore: Contract, // TODO: Rename to ConfigStore
    readonly hubPoolClient: HubPoolClient,
    readonly eventSearchConfig: EventSearchConfig = { fromBlock: 0, toBlock: null, maxBlockLookBack: 0 },
    readonly redisClient?: ReturnType<typeof createClient>
  ) {
    this.firstBlockToSearch = eventSearchConfig.fromBlock;
    this.blockFinder = new BlockFinder(this.configStore.provider.getBlock.bind(this.configStore.provider));
    this.rateModelDictionary = new across.rateModel.RateModelDictionary();
  }

  async computeRealizedLpFeePct(
    deposit: Deposit,
    l1Token: string
  ): Promise<{ realizedLpFeePct: BigNumber; quoteBlock: number }> {
    let quoteBlock = await this.getBlockNumber(deposit.quoteTimestamp);

    // There is one deposit on optimism for DAI that is right before the DAI rate model was added.
    if (quoteBlock === 14830339) quoteBlock = 14830390;

    // Test SNX deposit was before the rate model update for SNX.
    if (quoteBlock === 14856066) quoteBlock = 14856211;

    const rateModel = this.getRateModelForBlockNumber(l1Token, quoteBlock);

    // There is one deposit on optimism that is right at the margin of when liquidity was first added.
    if (quoteBlock > 14718100 && quoteBlock < 14718107) quoteBlock = 14718107;

    const { current, post } = await this.getUtilization(l1Token, quoteBlock, deposit.amount, deposit.quoteTimestamp);
    const realizedLpFeePct = lpFeeCalculator.calculateRealizedLpFeePct(rateModel, current, post);

    return { realizedLpFeePct, quoteBlock };
  }

  getRateModelForBlockNumber(l1Token: string, blockNumber: number | undefined = undefined): across.constants.RateModel {
    return this.rateModelDictionary.getRateModelForBlockNumber(l1Token, blockNumber);
  }

  getTokenTransferThresholdForBlock(l1Token: string, blockNumber: number = Number.MAX_SAFE_INTEGER): BigNumber {
    const config = (sortEventsDescending(this.cumulativeTokenTransferUpdates) as L1TokenTransferThreshold[]).find(
      (config) => config.blockNumber <= blockNumber && config.l1Token === l1Token
    );
    if (!config)
      throw new Error(`Could not find TransferThreshold for L1 token ${l1Token} before block ${blockNumber}`);
    return config.transferThreshold;
  }

  getSpokeTargetBalancesForBlock(
    l1Token: string,
    chainId: number,
    blockNumber: number = Number.MAX_SAFE_INTEGER
  ): SpokePoolTargetBalance {
    const config = (sortEventsDescending(this.cumulativeTokenTransferUpdates) as SpokeTargetBalanceUpdate[]).find(
      (config) => config.l1Token === l1Token && config.blockNumber <= blockNumber
    );
    const targetBalance = config?.spokeTargetBalances?.[chainId];
    return targetBalance || { target: toBN(0), threshold: toBN(0) };
  }

  getMaxRefundCountForRelayerRefundLeafForBlock(blockNumber: number = Number.MAX_SAFE_INTEGER): number {
    const config = (sortEventsDescending(this.cumulativeMaxRefundCountUpdates) as GlobalConfigUpdate[]).find(
      (config) => config.blockNumber <= blockNumber
    );
    if (!config) throw new Error(`Could not find MaxRefundCount before block ${blockNumber}`);
    return config.value;
  }

  getMaxL1TokenCountForPoolRebalanceLeafForBlock(blockNumber: number = Number.MAX_SAFE_INTEGER): number {
    const config = (sortEventsDescending(this.cumulativeMaxL1TokenCountUpdates) as GlobalConfigUpdate[]).find(
      (config) => config.blockNumber <= blockNumber
    );
    if (!config) throw new Error(`Could not find MaxL1TokenCount before block ${blockNumber}`);
    return config.value;
  }

  async update() {
    const searchConfig = {
      fromBlock: this.firstBlockToSearch,
      toBlock: this.eventSearchConfig.toBlock || (await this.configStore.provider.getBlockNumber()),
      maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
    };
    if (searchConfig.fromBlock > searchConfig.toBlock) return; // If the starting block is greater than

    this.logger.debug({ at: "ConfigStore", message: "Updating ConfigStore client", searchConfig });
    if (searchConfig[0] > searchConfig[1]) return; // If the starting block is greater than the ending block return.
    const [updatedTokenConfigEvents, updatedGlobalConfigEvents] = await Promise.all([
      paginatedEventQuery(this.configStore, this.configStore.filters.UpdatedTokenConfig(), searchConfig),
      paginatedEventQuery(this.configStore, this.configStore.filters.UpdatedGlobalConfig(), searchConfig),
    ]);

    // Save new TokenConfig updates.
    for (const event of updatedTokenConfigEvents) {
      const args = {
        ...(spreadEventWithBlockNumber(event) as TokenConfig),
      };

      try {
        const parsedValue = JSON.parse(args.value) as ParsedTokenConfig;
        const rateModelForToken = JSON.stringify(parsedValue.rateModel);
        const transferThresholdForToken = parsedValue.transferThreshold;

        // If Token config doesn't contain all expected properties, skip it.
        if (!(rateModelForToken && transferThresholdForToken)) {
          continue;
        }

        // Store RateModel:
        // TODO: Temporarily reformat the shape of the event that we pass into the sdk.rateModel class to make it fit
        // the expected shape. This is a fix for now that we should eventually replace when we change the sdk.rateModel
        // class itself to work with the generalized ConfigStore.
        const l1Token = args.key;
        delete args.value;
        delete args.key;
        this.cumulativeRateModelUpdates.push({ ...args, rateModel: rateModelForToken, l1Token });

        // Store transferThreshold
        this.cumulativeTokenTransferUpdates.push({
          ...args,
          transferThreshold: toBN(transferThresholdForToken),
          l1Token,
        });

        if (parsedValue?.spokeTargetBalances) {
          // Note: cast is required because fromEntries always produces string keys, despite the function returning a
          // numerical key.
          const targetBalances = Object.fromEntries(
            Object.entries(parsedValue.spokeTargetBalances).map(([chainId, targetBalance]) => {
              const target = min(toBN(targetBalance.target), toBN(0));
              const threshold = min(toBN(targetBalance.threshold), toBN(0));
              return [chainId, { target, threshold }];
            })
          ) as SpokeTargetBalanceUpdate["spokeTargetBalances"];
          this.cumulativeSpokeTargetBalanceUpdates.push({ ...args, spokeTargetBalances: targetBalances, l1Token });
        }
      } catch (err) {
        continue;
      }
    }

    // Save new Global config updates.
    for (const event of updatedGlobalConfigEvents) {
      const args = {
        blockNumber: event.blockNumber,
        transactionIndex: event.transactionIndex,
        logIndex: event.logIndex,
        ...spreadEvent(event),
      };

      if (args.key === utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.MAX_RELAYER_REPAYMENT_LEAF_SIZE)) {
        if (!isNaN(args.value)) this.cumulativeMaxRefundCountUpdates.push(args);
      } else if (args.key === utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.MAX_POOL_REBALANCE_LEAF_SIZE)) {
        if (!isNaN(args.value)) this.cumulativeMaxL1TokenCountUpdates.push(args);
      } else {
        continue;
      }
    }

    this.rateModelDictionary.updateWithEvents(this.cumulativeRateModelUpdates);

    this.isUpdated = true;
    this.firstBlockToSearch = searchConfig.toBlock + 1; // Next iteration should start off from where this one ended.

    this.logger.debug({ at: "ConfigStore", message: "ConfigStore client updated!" });
  }

  private async getBlockNumber(timestamp: number) {
    if (!this.redisClient) return (await this.blockFinder.getBlockForTimestamp(timestamp)).number;
    const key = `block_number_${timestamp}`;
    const result = await this.redisClient.get(key);
    if (result === null) {
      const blockNumber = (await this.blockFinder.getBlockForTimestamp(timestamp)).number;
      if (this.shouldCache(timestamp)) await this.redisClient.set(key, blockNumber.toString());
      return blockNumber;
    } else {
      return parseInt(result);
    }
  }

  private async getUtilization(l1Token: string, blockNumber: number, amount: BigNumber, timestamp: number) {
    if (!this.redisClient) return await this.hubPoolClient.getPostRelayPoolUtilization(l1Token, blockNumber, amount);
    const key = `utilization_${l1Token}_${blockNumber}_${amount.toString()}`;
    const result = await this.redisClient.get(key);
    if (result === null) {
      const { current, post } = await this.hubPoolClient.getPostRelayPoolUtilization(l1Token, blockNumber, amount);
      if (this.shouldCache(timestamp)) await this.redisClient.set(key, `${current.toString()},${post.toString()}`);
      return { current, post };
    } else {
      const [current, post] = result.split(",").map(BigNumber.from);
      return { current, post };
    }
  }

  // Avoid caching calls that are recent enough to be affected by things like reorgs.
  private shouldCache(eventTimestamp: number) {
    // Current time must be >= 5 minutes past the event timestamp for it to be stable enough to cache.
    return getCurrentTime() - eventTimestamp >= 300;
  }
}

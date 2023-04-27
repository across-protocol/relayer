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
  MakeOptional,
  toBN,
  max,
  getBlockForTimestamp,
  shouldCache,
  setRedisKey,
  sortEventsAscending,
  getRedis,
} from "../utils";

import { CHAIN_ID_LIST_INDICES, CONFIG_STORE_VERSION, DEFAULT_CONFIG_STORE_VERSION } from "../common/Constants";

import {
  L1TokenTransferThreshold,
  TokenConfig,
  GlobalConfigUpdate,
  ParsedTokenConfig,
  SpokeTargetBalanceUpdate,
  SpokePoolTargetBalance,
  RouteRateModelUpdate,
  ConfigStoreVersionUpdate,
  DisabledChainsUpdate,
} from "../interfaces";

import { lpFeeCalculator } from "@across-protocol/sdk-v2";
import { BlockFinder, across } from "@uma/sdk";
import { HubPoolClient } from "./HubPoolClient";

export const GLOBAL_CONFIG_STORE_KEYS = {
  MAX_RELAYER_REPAYMENT_LEAF_SIZE: "MAX_RELAYER_REPAYMENT_LEAF_SIZE",
  MAX_POOL_REBALANCE_LEAF_SIZE: "MAX_POOL_REBALANCE_LEAF_SIZE",
  VERSION: "VERSION",
  DISABLED_CHAINS: "DISABLED_CHAINS",
};

export class AcrossConfigStoreClient {
  public readonly blockFinder;

  public cumulativeRateModelUpdates: across.rateModel.RateModelEvent[] = [];
  public cumulativeRouteRateModelUpdates: RouteRateModelUpdate[] = [];
  public cumulativeTokenTransferUpdates: L1TokenTransferThreshold[] = [];
  public cumulativeMaxRefundCountUpdates: GlobalConfigUpdate[] = [];
  public cumulativeMaxL1TokenCountUpdates: GlobalConfigUpdate[] = [];
  public cumulativeSpokeTargetBalanceUpdates: SpokeTargetBalanceUpdate[] = [];
  public cumulativeConfigStoreVersionUpdates: ConfigStoreVersionUpdate[] = [];
  public cumulativeDisabledChainUpdates: DisabledChainsUpdate[] = [];

  private rateModelDictionary: across.rateModel.RateModelDictionary;
  public firstBlockToSearch: number;

  public hasLatestConfigStoreVersion = false;

  public isUpdated = false;

  constructor(
    readonly logger: winston.Logger,
    readonly configStore: Contract,
    readonly hubPoolClient: HubPoolClient,
    readonly eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 },
    readonly enabledChainIds: number[] = CHAIN_ID_LIST_INDICES
  ) {
    this.firstBlockToSearch = eventSearchConfig.fromBlock;
    this.blockFinder = new BlockFinder(this.configStore.provider.getBlock.bind(this.configStore.provider));
    this.rateModelDictionary = new across.rateModel.RateModelDictionary();
  }

  async computeRealizedLpFeePct(
    deposit: { quoteTimestamp: number; amount: BigNumber; destinationChainId: number; originChainId: number },
    l1Token: string
  ): Promise<{ realizedLpFeePct: BigNumber; quoteBlock: number }> {
    let quoteBlock = await this.getBlockNumber(deposit.quoteTimestamp);

    // There is one deposit on optimism for DAI that is right before the DAI rate model was added.
    if (quoteBlock === 14830339) {
      quoteBlock = 14830390;
    }

    // Test SNX deposit was before the rate model update for SNX.
    if (quoteBlock === 14856066) {
      quoteBlock = 14856211;
    }

    // Test deposit on Goerli was before rate model update.
    if (quoteBlock === 8824889) {
      quoteBlock = 8825016;
    }

    const rateModel = this.getRateModelForBlockNumber(
      l1Token,
      deposit.originChainId,
      deposit.destinationChainId,
      quoteBlock
    );

    // There is one deposit on optimism that is right at the margin of when liquidity was first added.
    if (quoteBlock > 14718100 && quoteBlock < 14718107) {
      quoteBlock = 14718107;
    }

    const { current, post } = await this.getUtilization(l1Token, quoteBlock, deposit.amount, deposit.quoteTimestamp);
    const realizedLpFeePct = lpFeeCalculator.calculateRealizedLpFeePct(rateModel, current, post);

    return { realizedLpFeePct, quoteBlock };
  }

  getRateModelForBlockNumber(
    l1Token: string,
    originChainId: number | string,
    destinationChainId: number | string,
    blockNumber: number | undefined = undefined
  ): across.constants.RateModel {
    // Use route-rate model if available, otherwise use default rate model for l1Token.
    const route = `${originChainId}-${destinationChainId}`;
    const routeRateModel = this.getRouteRateModelForBlockNumber(l1Token, route, blockNumber);
    return routeRateModel ?? this.rateModelDictionary.getRateModelForBlockNumber(l1Token, blockNumber);
  }

  getRouteRateModelForBlockNumber(
    l1Token: string,
    route: string,
    blockNumber: number | undefined = undefined
  ): across.constants.RateModel | undefined {
    const config = (sortEventsDescending(this.cumulativeRouteRateModelUpdates) as RouteRateModelUpdate[]).find(
      (config) => config.blockNumber <= (blockNumber ?? 0) && config.l1Token === l1Token
    );
    if (config?.routeRateModel[route] === undefined) {
      return undefined;
    }
    return across.rateModel.parseAndReturnRateModelFromString(config.routeRateModel[route]);
  }

  getTokenTransferThresholdForBlock(l1Token: string, blockNumber: number = Number.MAX_SAFE_INTEGER): BigNumber {
    const config = (sortEventsDescending(this.cumulativeTokenTransferUpdates) as L1TokenTransferThreshold[]).find(
      (config) => config.blockNumber <= blockNumber && config.l1Token === l1Token
    );
    if (!config) {
      throw new Error(`Could not find TransferThreshold for L1 token ${l1Token} before block ${blockNumber}`);
    }
    return config.transferThreshold;
  }

  getSpokeTargetBalancesForBlock(
    l1Token: string,
    chainId: number,
    blockNumber: number = Number.MAX_SAFE_INTEGER
  ): SpokePoolTargetBalance {
    const config = (sortEventsDescending(this.cumulativeSpokeTargetBalanceUpdates) as SpokeTargetBalanceUpdate[]).find(
      (config) => config.l1Token === l1Token && config.blockNumber <= blockNumber
    );
    const targetBalance = config?.spokeTargetBalances?.[chainId];
    return targetBalance || { target: toBN(0), threshold: toBN(0) };
  }

  getMaxRefundCountForRelayerRefundLeafForBlock(blockNumber: number = Number.MAX_SAFE_INTEGER): number {
    const config = (sortEventsDescending(this.cumulativeMaxRefundCountUpdates) as GlobalConfigUpdate[]).find(
      (config) => config.blockNumber <= blockNumber
    );
    if (!config) {
      throw new Error(`Could not find MaxRefundCount before block ${blockNumber}`);
    }
    return Number(config.value);
  }

  getMaxL1TokenCountForPoolRebalanceLeafForBlock(blockNumber: number = Number.MAX_SAFE_INTEGER): number {
    const config = (sortEventsDescending(this.cumulativeMaxL1TokenCountUpdates) as GlobalConfigUpdate[]).find(
      (config) => config.blockNumber <= blockNumber
    );
    if (!config) {
      throw new Error(`Could not find MaxL1TokenCount before block ${blockNumber}`);
    }
    return Number(config.value);
  }

  /**
   * Returns list of chains that have been enabled at least once in the block range.
   * If a chain was disabled in the block range, it will be included in the list provided it was enabled
   * at some point in the block range.
   * @dev If fromBlock == toBlock then defaults to returning enabled chains at fromBlock
   * @param fromBlock Start block to search inclusive
   * @param toBlock End block to search inclusive. Defaults to MAX_SAFE_INTEGER, so grabs all disabled chain events
   * up until `latest`.
   * @param allPossibleChains Returned list will be a subset of this list.
   * @returns List of chain IDs that have been enabled at least once in the block range. Sorted from lowest to highest.
   */
  getEnabledChainsInBlockRange(
    fromBlock: number,
    toBlock = Number.MAX_SAFE_INTEGER,
    allPossibleChains = this.enabledChainIds
  ): number[] {
    if (toBlock < fromBlock) {
      throw new Error(`Invalid block range: fromBlock ${fromBlock} > toBlock ${toBlock}`);
    }
    // Initiate list with all chains enabled at the fromBlock.
    const disabledChainsAtFromBlock = this.getDisabledChainsForBlock(fromBlock);
    const enabledChainsAtFromBlock = allPossibleChains.filter(
      (chainId) => !disabledChainsAtFromBlock.includes(chainId)
    );

    // Update list of enabled chains with any of the candidate chains that have been removed from the
    // disabled list during the block range.
    return sortEventsAscending(this.cumulativeDisabledChainUpdates)
      .reduce((enabledChains: number[], disabledChainUpdate) => {
        if (disabledChainUpdate.blockNumber > toBlock || disabledChainUpdate.blockNumber < fromBlock) {
          return enabledChains;
        }
        // If any of the possible chains are not listed in this disabled chain update and are not already in the
        // enabled chain list, then add them to the list.
        allPossibleChains.forEach((chainId) => {
          if (!disabledChainUpdate.chainIds.includes(chainId) && !enabledChains.includes(chainId)) {
            enabledChains.push(chainId);
          }
        });
        return enabledChains;
      }, enabledChainsAtFromBlock)
      .sort((a, b) => a - b);
  }

  getEnabledChains(block = Number.MAX_SAFE_INTEGER, allPossibleChains = this.enabledChainIds): number[] {
    // Get most recent disabled chain list before the block specified.
    const currentlyDisabledChains = this.getDisabledChainsForBlock(block);
    return allPossibleChains.filter((chainId) => !currentlyDisabledChains.includes(chainId));
  }

  getDisabledChainsForBlock(blockNumber: number = Number.MAX_SAFE_INTEGER): number[] {
    return (
      sortEventsDescending(this.cumulativeDisabledChainUpdates).find((config) => config.blockNumber <= blockNumber)
        ?.chainIds ?? []
    );
  }

  getConfigStoreVersionForTimestamp(timestamp: number = Number.MAX_SAFE_INTEGER): number {
    const config = (sortEventsDescending(this.cumulativeConfigStoreVersionUpdates) as ConfigStoreVersionUpdate[]).find(
      (config) => config.timestamp <= timestamp
    );
    if (!config) {
      return DEFAULT_CONFIG_STORE_VERSION;
    }
    return Number(config.value);
  }

  hasValidConfigStoreVersionForTimestamp(timestamp: number = Number.MAX_SAFE_INTEGER): boolean {
    const version = this.getConfigStoreVersionForTimestamp(timestamp);
    return this.isValidConfigStoreVersion(version);
  }

  isValidConfigStoreVersion(version: number): boolean {
    return CONFIG_STORE_VERSION >= version;
  }

  async update(): Promise<void> {
    const searchConfig = {
      fromBlock: this.firstBlockToSearch,
      toBlock: this.eventSearchConfig.toBlock || (await this.configStore.provider.getBlockNumber()),
      maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
    };
    if (searchConfig.fromBlock > searchConfig.toBlock) {
      return;
    } // If the starting block is greater than

    this.logger.debug({ at: "ConfigStore", message: "Updating ConfigStore client", searchConfig });
    if (searchConfig.fromBlock > searchConfig.toBlock) {
      return;
    } // If the starting block is greater than the ending block return.
    const [updatedTokenConfigEvents, updatedGlobalConfigEvents] = await Promise.all([
      paginatedEventQuery(this.configStore, this.configStore.filters.UpdatedTokenConfig(), searchConfig),
      paginatedEventQuery(this.configStore, this.configStore.filters.UpdatedGlobalConfig(), searchConfig),
    ]);
    const globalConfigUpdateTimes = (
      await Promise.all(updatedGlobalConfigEvents.map((event) => this.configStore.provider.getBlock(event.blockNumber)))
    ).map((block) => block.timestamp);

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

        // Drop value and key before passing args.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { value, key, ...passedArgs } = args;
        this.cumulativeRateModelUpdates.push({ ...passedArgs, rateModel: rateModelForToken, l1Token });

        // Store transferThreshold
        this.cumulativeTokenTransferUpdates.push({
          ...passedArgs,
          transferThreshold: toBN(transferThresholdForToken),
          l1Token,
        });

        // Store spokeTargetBalances
        if (parsedValue?.spokeTargetBalances) {
          // Note: cast is required because fromEntries always produces string keys, despite the function returning a
          // numerical key.
          const targetBalances = Object.fromEntries(
            Object.entries(parsedValue.spokeTargetBalances).map(([chainId, targetBalance]) => {
              const target = max(toBN(targetBalance.target), toBN(0));
              const threshold = max(toBN(targetBalance.threshold), toBN(0));
              return [chainId, { target, threshold }];
            })
          ) as SpokeTargetBalanceUpdate["spokeTargetBalances"];
          this.cumulativeSpokeTargetBalanceUpdates.push({
            ...passedArgs,
            spokeTargetBalances: targetBalances,
            l1Token,
          });
        } else {
          this.cumulativeSpokeTargetBalanceUpdates.push({ ...passedArgs, spokeTargetBalances: {}, l1Token });
        }

        // Store route-specific rate models
        if (parsedValue?.routeRateModel) {
          const routeRateModel = Object.fromEntries(
            Object.entries(parsedValue.routeRateModel).map(([path, routeRateModel]) => {
              return [path, JSON.stringify(routeRateModel)];
            })
          );
          this.cumulativeRouteRateModelUpdates.push({ ...passedArgs, routeRateModel, l1Token });
        } else {
          this.cumulativeRouteRateModelUpdates.push({ ...passedArgs, routeRateModel: {}, l1Token });
        }
      } catch (err) {
        continue;
      }
    }

    // Save new Global config updates.
    for (let i = 0; i < updatedGlobalConfigEvents.length; i++) {
      const event = updatedGlobalConfigEvents[i];
      const args = {
        blockNumber: event.blockNumber,
        transactionIndex: event.transactionIndex,
        logIndex: event.logIndex,
        ...spreadEvent(event.args),
      };

      if (args.key === utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.MAX_RELAYER_REPAYMENT_LEAF_SIZE)) {
        if (!isNaN(args.value)) {
          this.cumulativeMaxRefundCountUpdates.push(args);
        }
      } else if (args.key === utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.MAX_POOL_REBALANCE_LEAF_SIZE)) {
        if (!isNaN(args.value)) {
          this.cumulativeMaxL1TokenCountUpdates.push(args);
        }
      } else if (args.key === utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.VERSION)) {
        // If not a number, skip.
        if (isNaN(args.value)) {
          continue;
        }
        const value = Number(args.value);

        // If not an integer, skip.
        if (!Number.isInteger(value)) {
          continue;
        }

        // Extract last version
        const lastValue =
          this.cumulativeConfigStoreVersionUpdates.length === 0
            ? DEFAULT_CONFIG_STORE_VERSION
            : Number(
                this.cumulativeConfigStoreVersionUpdates[this.cumulativeConfigStoreVersionUpdates.length - 1].value
              );

        // If version is not > last version, skip.
        if (value <= lastValue) {
          continue;
        }

        this.cumulativeConfigStoreVersionUpdates.push({
          ...args,
          timestamp: globalConfigUpdateTimes[i],
        });
      } else if (args.key === utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.DISABLED_CHAINS)) {
        try {
          const chainIds = this.filterDisabledChains(JSON.parse(args.value) as number[]);
          this.cumulativeDisabledChainUpdates.push({ ...args, chainIds });
        } catch (err) {
          // Can't parse list, skip.
        }
      } else {
        continue;
      }
    }

    this.rateModelDictionary.updateWithEvents(this.cumulativeRateModelUpdates);

    this.hasLatestConfigStoreVersion = this.hasValidConfigStoreVersionForTimestamp();
    this.isUpdated = true;
    this.firstBlockToSearch = searchConfig.toBlock + 1; // Next iteration should start off from where this one ended.

    this.logger.debug({ at: "ConfigStore", message: "ConfigStore client updated!" });
  }

  filterDisabledChains(disabledChains: number[]): number[] {
    // If any chain ID's are not integers then ignore. UMIP-157 requires that this key cannot include
    // the chain ID 1.
    return disabledChains.filter((chainId: number) => !isNaN(chainId) && Number.isInteger(chainId) && chainId !== 1);
  }

  private async getBlockNumber(timestamp: number): Promise<number | undefined> {
    return await getBlockForTimestamp(
      this.hubPoolClient.chainId,
      this.hubPoolClient.chainId,
      timestamp,
      getCurrentTime(),
      this.blockFinder
    );
  }

  private async getUtilization(
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

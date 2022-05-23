import { spreadEvent, winston, Contract, BigNumber, sortEventsDescending, spreadEventWithBlockNumber } from "../utils";
import { paginatedEventQuery, EventSearchConfig, utf8ToHex } from "../utils";
import { L1TokenTransferThreshold, Deposit, TokenConfig } from "../interfaces";
import { GlobalConfigUpdate } from "../interfaces";

import { lpFeeCalculator } from "@across-protocol/sdk-v2";
import { BlockFinder, across } from "@uma/sdk";
import { HubPoolClient } from "./HubPoolClient";

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

  private rateModelDictionary: across.rateModel.RateModelDictionary;
  public firstBlockToSearch: number;

  public isUpdated: boolean = false;

  constructor(
    readonly logger: winston.Logger,
    readonly configStore: Contract, // TODO: Rename to ConfigStore
    readonly hubPoolClient: HubPoolClient,
    readonly eventSearchConfig: EventSearchConfig = { fromBlock: 0, toBlock: null, maxBlockLookBack: 0 }
  ) {
    this.firstBlockToSearch = eventSearchConfig.fromBlock;
    this.blockFinder = new BlockFinder(this.configStore.provider.getBlock.bind(this.configStore.provider));
    this.rateModelDictionary = new across.rateModel.RateModelDictionary();
  }

  async computeRealizedLpFeePct(
    deposit: Deposit,
    l1Token: string
  ): Promise<{ realizedLpFeePct: BigNumber; quoteBlock: number }> {
    let quoteBlock = (await this.blockFinder.getBlockForTimestamp(deposit.quoteTimestamp)).number;
    const rateModel = this.getRateModelForBlockNumber(l1Token, quoteBlock);

    // There is one deposit on optimism that is right at the margin of when liquidity was first added.
    if (quoteBlock > 14718100 && quoteBlock < 14718107) quoteBlock = 14718107;

    // There is one deposit on optimism for DAI that is right before the DAI rate model was added.
    if (quoteBlock === 14830339) quoteBlock = 14830390;

    const { current, post } = await this.hubPoolClient.getPostRelayPoolUtilization(l1Token, quoteBlock, deposit.amount);
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

    this.logger.debug({ at: "RateModelClient", message: "Updating client", searchConfig });
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
        const rateModelForToken = JSON.stringify(JSON.parse(args.value).rateModel);
        const transferThresholdForToken = JSON.parse(args.value).transferThreshold;

        // If Token config doesn't contain all expected properties, skip it.
        if (!(rateModelForToken && transferThresholdForToken)) {
          this.logger.debug({ at: "RateModelClient", message: "Skipping invalid token config", args });
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
        this.cumulativeTokenTransferUpdates.push({ ...args, transferThreshold: transferThresholdForToken, l1Token });
      } catch (err) {
        this.logger.debug({ at: "RateModelClient", message: "Cannot parse value to JSON", args });
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
        this.logger.debug({ at: "RateModelClient", message: "Skipping unknown global config key", args });
        continue;
      }
    }

    this.rateModelDictionary.updateWithEvents(this.cumulativeRateModelUpdates);

    this.isUpdated = true;
    this.firstBlockToSearch = searchConfig.toBlock + 1; // Next iteration should start off from where this one ended.

    this.logger.debug({ at: "RateModelClient", message: "Client updated!" });
  }
}

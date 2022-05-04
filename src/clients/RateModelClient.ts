import { spreadEvent, winston, Contract, BigNumber, paginatedEventQuery, EventSearchConfig, assert, toBN } from "../utils";
import { L1TokenTransferThreshold, Deposit } from "../interfaces";
import { lpFeeCalculator } from "@across-protocol/sdk-v2";
import { BlockFinder, across } from "@uma/sdk";
import { HubPoolClient } from "./HubPoolClient";

export class AcrossConfigStoreClient {
  private readonly blockFinder;

  public cumulativeRateModelUpdates: across.rateModel.RateModelEvent[] = [];
  public cumulativeTokenTransferUpdates: L1TokenTransferThreshold[] = [];
  private rateModelDictionary: across.rateModel.RateModelDictionary;
  public poolRebalanceTokenTransferThreshold: { [l1Token: string]: BigNumber };
  public firstBlockToSearch: number;

  public isUpdated: boolean = false;

  constructor(
    readonly logger: winston.Logger,
    readonly rateModelStore: Contract, // TODO: Rename to ConfigStore
    readonly hubPoolClient: HubPoolClient,
    _poolRebalanceTokenTransferThreshold: { [l1Token: string]: BigNumber },
    readonly maxRefundsPerRelayerRefundLeaf: number = 25,
    readonly maxL1TokensPerPoolRebalanceLeaf: number = 25,
    readonly eventSearchConfig: EventSearchConfig = { fromBlock: 0, toBlock: null, maxBlockLookBack: 0 }
  ) {
    this.firstBlockToSearch = eventSearchConfig.fromBlock;
    this.blockFinder = new BlockFinder(this.rateModelStore.provider.getBlock.bind(this.rateModelStore.provider));
    this.rateModelDictionary = new across.rateModel.RateModelDictionary();
    Object.values(_poolRebalanceTokenTransferThreshold).forEach((threshold: BigNumber) =>
      assert(threshold.gte(toBN(0)), "Threshold cannot be negative")
    );
    this.poolRebalanceTokenTransferThreshold = _poolRebalanceTokenTransferThreshold;
  }

  // Used for testing, should we block this function in prod?
  setPoolRebalanceTokenTransferThreshold(l1Token: string, newThreshold: BigNumber) {
    assert(newThreshold.gte(toBN(0)), "Threshold cannot be negative");
    this.poolRebalanceTokenTransferThreshold[l1Token] = newThreshold;
  }
  
  async computeRealizedLpFeePct(
    deposit: Deposit,
    l1Token: string
  ): Promise<{ realizedLpFeePct: BigNumber; quoteBlock: number }> {
    // The below is a temp work around to deal with the incorrect deployment that was done on all test nets. If the rate
    // model store is deployed after the a fill is done then some calls to this method will fail, resulting in an error.
    // For test nets we can just work around this by using the latest block number.
    let quoteBlock = 0;
    let rateModel: any;
    try {
      quoteBlock = (await this.blockFinder.getBlockForTimestamp(deposit.quoteTimestamp)).number;
      rateModel = this.getRateModelForBlockNumber(l1Token, quoteBlock);
    } catch (error) {
      if ((await this.hubPoolClient.hubPool.provider.getNetwork()).chainId === 1)
        throw new Error("Bad rate model store deployment");

      quoteBlock = await this.blockFinder.getLatestBlock().number;
      rateModel = this.getRateModelForBlockNumber(l1Token, quoteBlock);
    }

    const { current, post } = await this.hubPoolClient.getPostRelayPoolUtilization(l1Token, quoteBlock, deposit.amount);

    const realizedLpFeePct = lpFeeCalculator.calculateRealizedLpFeePct(rateModel, current, post);

    this.logger.debug({
      at: "RateModelClient",
      message: "Computed realizedLPFeePct",
      depositId: deposit.depositId,
      originChainId: deposit.originChainId,
      quoteBlock,
      rateModel,
      realizedLpFeePct,
    });

    return { realizedLpFeePct, quoteBlock };
  }

  getRateModelForBlockNumber(l1Token: string, blockNumber: number | undefined = undefined): across.constants.RateModel {
    return this.rateModelDictionary.getRateModelForBlockNumber(l1Token, blockNumber);
  }

  async update() {
    const searchConfig = {
      fromBlock: this.firstBlockToSearch,
      toBlock: this.eventSearchConfig.toBlock || (await this.rateModelStore.provider.getBlockNumber()),
      maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
    };
    if (searchConfig.fromBlock > searchConfig.toBlock) return; // If the starting block is greater than
    if (this.hubPoolClient !== null && !this.hubPoolClient.isUpdated) throw new Error("HubPool not updated");

    this.logger.debug({ at: "RateModelClient", message: "Updating client", searchConfig });
    if (searchConfig[0] > searchConfig[1]) return; // If the starting block is greater than the ending block return.
    const [updatedTokenConfigEvents, updatedGlobalConfigEvents] = await Promise.all([
      paginatedEventQuery(this.rateModelStore, this.rateModelStore.filters.UpdatedTokenConfig(), searchConfig),
      paginatedEventQuery(this.rateModelStore, this.rateModelStore.filters.UpdatedGlobalConfig(), searchConfig),
    ]);

    for (const event of updatedTokenConfigEvents) {
      const args = {
        blockNumber: event.blockNumber,
        transactionIndex: event.transactionIndex,
        logIndex: event.logIndex,
        ...spreadEvent(event),
      };

      const rateModelForToken = JSON.parse(args.value).rateModel;
      const transferThresholdForToken = JSON.parse(args.value).transferThreshold;
      if (!(rateModelForToken && transferThresholdForToken))
        throw new Error("l1TokenConfig missing rateModel or transferThreshold");

      // Store RateModel:
      // TODO: Temporarily reformat the shape of the event that we pass into the sdk.rateModel class to make it fit
      // the expected shape. This is a fix for now that we should eventually replace when we change the sdk.rateModel
      // class itself to work with the generalized ConfigStore.
      args.rateModel = rateModelForToken;
      args.l1Token = args.key;
      delete args.value;
      delete args.key;
      this.cumulativeRateModelUpdates.push({ ...args });

      // Store transferThreshold
      args.transferThreshold = transferThresholdForToken;
      delete args.rateModel;
      this.cumulativeTokenTransferUpdates.push({ ...args });
    }

    // Sort events by block height in ascending order:
    this.rateModelDictionary.updateWithEvents(this.cumulativeRateModelUpdates);

    this.isUpdated = true;
    this.firstBlockToSearch = searchConfig.toBlock + 1; // Next iteration should start off from where this one ended.

    this.logger.debug({ at: "RateModelClient", message: "Client updated!" });
  }
}

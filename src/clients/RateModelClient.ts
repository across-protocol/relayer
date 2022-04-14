import { spreadEvent, winston, Contract, BigNumber } from "../utils";
import { Deposit } from "../interfaces/SpokePool";
import { lpFeeCalculator } from "@across-protocol/sdk-v2";
import { BlockFinder, across } from "@uma/sdk";
import { HubPoolClient } from "./HubPoolClient";

export class RateModelClient {
  private readonly blockFinder;

  public cumulativeRateModelEvents: across.rateModel.RateModelEvent[] = [];
  private rateModelDictionary: across.rateModel.RateModelDictionary;
  public firstBlockToSearch: number;

  public isUpdated: boolean = false;

  constructor(
    readonly logger: winston.Logger,
    readonly rateModelStore: Contract,
    readonly hubPoolClient: HubPoolClient,
    readonly startingBlock: number = 0
  ) {
    this.firstBlockToSearch = startingBlock;
    this.blockFinder = new BlockFinder(this.rateModelStore.provider.getBlock.bind(this.rateModelStore.provider));
    this.rateModelDictionary = new across.rateModel.RateModelDictionary();
  }

  async computeRealizedLpFeePct(deposit: Deposit, l1Token: string): Promise<BigNumber> {
    // const quoteBlock = (await this.blockFinder.getBlockForTimestamp(deposit.quoteTimestamp)).number;
    const quoteBlock = 10469009;
    // const quoteBlock = (await this.blockFinder.getBlockForTimestamp(deposit.quoteTimestamp)).number;

    const { current, post } = await this.hubPoolClient.getPostRelayPoolUtilization(l1Token, quoteBlock, deposit.amount);

    const rateModel = this.getRateModelForBlockNumber(l1Token, quoteBlock);
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

    return realizedLpFeePct;
  }

  getRateModelForBlockNumber(l1Token: string, blockNumber: number | undefined = undefined): across.constants.RateModel {
    return this.rateModelDictionary.getRateModelForBlockNumber(l1Token, blockNumber);
  }

  async update() {
    const searchConfig = [this.firstBlockToSearch, await this.rateModelStore.provider.getBlockNumber()];
    this.logger.debug({ at: "RateModelClient", message: "Updating client", searchConfig });
    if (searchConfig[0] > searchConfig[1]) return; // If the starting block is greater than the ending block return.
    const rateModelStoreEvents = await this.rateModelStore.queryFilter(
      this.rateModelStore.filters.UpdatedRateModel(),
      ...searchConfig
    );

    for (const event of rateModelStoreEvents) {
      const args = {
        blockNumber: event.blockNumber,
        transactionIndex: event.transactionIndex,
        logIndex: event.logIndex,
        ...spreadEvent(event),
      };
      this.cumulativeRateModelEvents = [...this.cumulativeRateModelEvents, args];
    }
    this.rateModelDictionary.updateWithEvents(this.cumulativeRateModelEvents);

    this.isUpdated = true;
    this.firstBlockToSearch = searchConfig[1] + 1; // Next iteration should start off from where this one ended.

    this.logger.debug({ at: "RateModelClient", message: "Client updated!" });
  }
}

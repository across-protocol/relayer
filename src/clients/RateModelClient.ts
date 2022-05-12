import { winston, Contract, BigNumber } from "../utils";
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
    readonly configStore: Contract,
    readonly hubPoolClient: HubPoolClient,
    readonly startingBlock: number = 0
  ) {
    this.firstBlockToSearch = startingBlock;
    this.blockFinder = new BlockFinder(this.configStore.provider.getBlock.bind(this.configStore.provider));
    this.rateModelDictionary = new across.rateModel.RateModelDictionary();
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
    if (this.hubPoolClient !== null && !this.hubPoolClient.isUpdated) throw new Error("HubPool not updated");

    const searchConfig = [this.firstBlockToSearch, await this.configStore.provider.getBlockNumber()];
    this.logger.debug({ at: "RateModelClient", message: "Updating client", searchConfig });
    if (searchConfig[0] > searchConfig[1]) return; // If the starting block is greater than the ending block return.
    const rateModelEvents = await this.configStore.queryFilter(
      this.configStore.filters.UpdatedTokenConfig(),
      ...searchConfig
    );

    for (const event of rateModelEvents) {
      const args = {
        blockNumber: event.blockNumber,
        transactionIndex: event.transactionIndex,
        logIndex: event.logIndex,
        rateModel: event.args.value,
        l1Token: event.args.key,
      };
      this.cumulativeRateModelEvents = [...this.cumulativeRateModelEvents, args];
    }
    this.rateModelDictionary.updateWithEvents(this.cumulativeRateModelEvents);

    this.isUpdated = true;
    this.firstBlockToSearch = searchConfig[1] + 1; // Next iteration should start off from where this one ended.

    this.logger.debug({ at: "RateModelClient", message: "Client updated!" });
  }
}

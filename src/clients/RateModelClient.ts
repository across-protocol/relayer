import { spreadEvent, assign, Contract, toBNWei, Block, BigNumber, toBN, utils } from "../utils";
import { Deposit, Fill } from "../interfaces/SpokePool";
import { lpFeeCalculator } from "@across-protocol/sdk-v2";
import { BlockFinder, across } from "@uma/sdk";
import { HubPoolClient } from "./HubPoolClient";

export class RateModelClient {
  private readonly blockFinder;

  private cumulativeRateModelEvents: across.rateModel.RateModelEvent[] = [];
  private rateModelDictionary: across.rateModel.RateModelDictionary;

  public firstBlockToSearch: number;

  constructor(readonly rateModelStore: Contract, readonly hubPoolClient: HubPoolClient) {
    this.blockFinder = new BlockFinder(
      this.hubPoolClient.getProvider().getBlock.bind(this.hubPoolClient.getProvider())
    );
    this.rateModelDictionary = new across.rateModel.RateModelDictionary();
  }

  async computeRealizedLpFeePct(deposit: Deposit, l1Token: string) {
    const quoteBlockNumber = (await this.blockFinder.getBlockForTimestamp(deposit.quoteTimestamp)).number;

    const rateModelForBlockNumber = this.getRateModelForBlockNumber(l1Token, quoteBlockNumber);

    const blockOffset = { blockTag: quoteBlockNumber };
    const [liquidityUtilizationCurrent, liquidityUtilizationPostRelay] = await Promise.all([
      this.hubPoolClient.hubPool.callStatic.liquidityUtilizationCurrent(l1Token, blockOffset),
      this.hubPoolClient.hubPool.callStatic.liquidityUtilizationPostRelay(l1Token, deposit.amount, blockOffset),
    ]);

    const realizedLpFeePct = lpFeeCalculator.calculateRealizedLpFeePct(
      rateModelForBlockNumber,
      liquidityUtilizationCurrent,
      liquidityUtilizationPostRelay
    );

    return toBN(realizedLpFeePct);
  }

  getRateModelForBlockNumber(l1Token: string, blockNumber: number | undefined = undefined): across.constants.RateModel {
    return this.rateModelDictionary.getRateModelForBlockNumber(l1Token, blockNumber);
  }

  async validateRealizedLpFeePctForFill(fill: Fill, deposit: Deposit) {
    const expectedFee = await this.computeRealizedLpFeePct(deposit, this.hubPoolClient.getL1TokenForDeposit(deposit));
    if (!expectedFee.eq(fill.realizedLpFeePct)) return false;
  }

  async update() {
    const searchConfig = [this.firstBlockToSearch, await this.hubPoolClient.getBlockNumber()];
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
  }
}

import { spreadEvent, assign, Contract, toBNWei, Block, BigNumber, toBN, utils } from "./utils";
import { Deposit, Fill, SpeedUp } from "./interfaces/SpokePool";
import { destinationChainId } from "../test/utils";
import { BlockFinder, across } from "@uma/sdk";

import { lpFeeCalculator } from "@across-protocol/sdk-v2";

export class HubPoolEventClient {
  // l1Token -> destinationChainId -> destinationToken
  private l1TokensToDestinationTokens: { [l1Token: string]: { [destinationChainId: number]: string } } = {};

  private readonly blockFinder;

  private cumulativeRateModelEvents: across.rateModel.RateModelEvent[] = [];
  private rateModelDictionary: across.rateModel.RateModelDictionary;

  public firstBlockToSearch: number;

  constructor(
    readonly hubPool: Contract,
    readonly rateModelStore: Contract,
    readonly startingBlock: number = 0,
    readonly endingBlock: number | null = null
  ) {
    this.blockFinder = new BlockFinder(this.hubPool.provider.getBlock.bind(this.hubPool.provider));
    this.rateModelDictionary = new across.rateModel.RateModelDictionary();
  }

  async computeRealizedLpFeePctForDeposit(deposit: Deposit) {
    const quoteBlockNumber = (await this.blockFinder.getBlockForTimestamp(deposit.quoteTimestamp)).number;

    const l1Token = this.getL1TokenForDeposit(deposit);
    const rateModelForBlockNumber = this.getRateModelForBlockNumber(l1Token, quoteBlockNumber);

    const blockOffset = { blockTag: quoteBlockNumber };
    const [liquidityUtilizationCurrent, liquidityUtilizationPostRelay] = await Promise.all([
      this.hubPool.callStatic.liquidityUtilizationCurrent(l1Token, blockOffset),
      this.hubPool.callStatic.liquidityUtilizationPostRelay(l1Token, deposit.amount.toString(), blockOffset),
    ]);

    const realizedLpFeePct = across.feeCalculator.calculateRealizedLpFeePct(
      rateModelForBlockNumber,
      liquidityUtilizationCurrent,
      liquidityUtilizationPostRelay
    );

    return realizedLpFeePct;
  }

  getRateModelForBlockNumber(l1Token: string, blockNumber: number | undefined = undefined): across.constants.RateModel {
    return this.rateModelDictionary.getRateModelForBlockNumber(l1Token, blockNumber);
  }

  getDestinationTokenForDeposit(deposit: Deposit) {
    const l1Token = this.getL1TokenForDeposit(deposit);
    return this.getDestinationTokenForL1TokenAndDestinationChainId(l1Token, deposit.destinationChainId);
  }

  getL1TokensToDestinationTokens() {
    return this.l1TokensToDestinationTokens;
  }

  getL1TokenForDeposit(deposit: Deposit) {
    let l1Token = null;
    Object.keys(this.l1TokensToDestinationTokens).forEach((_l1Token) => {
      if (this.l1TokensToDestinationTokens[_l1Token][deposit.originChainId.toString()] === deposit.originToken)
        l1Token = _l1Token;
    });
    return l1Token;
  }

  getDestinationTokenForL1TokenAndDestinationChainId(l1Token: string, destinationChainId: number) {
    return this.l1TokensToDestinationTokens[l1Token][destinationChainId];
  }

  validateFillForDeposit(fill: Fill, deposit: Deposit) {
    // TODO: this method should validate the realizedLpFeePct and the destinationToken for the fill->deposit relationship.
    return true;
  }

  async update() {
    const searchConfig = [this.firstBlockToSearch, this.endingBlock || (await this.getBlockNumber())];
    if (searchConfig[0] > searchConfig[1]) return; // If the starting block is greater than the ending block return.
    const [poolRebalanceRouteEvents, rateModelStoreEvents] = await Promise.all([
      this.hubPool.queryFilter(this.hubPool.filters.SetPoolRebalanceRoute(), ...searchConfig),
      this.rateModelStore.queryFilter(this.rateModelStore.filters.UpdatedRateModel(), ...searchConfig),
    ]);

    for (const event of poolRebalanceRouteEvents) {
      const args = spreadEvent(event);
      assign(this.l1TokensToDestinationTokens, [args.l1Token, args.destinationChainId], args.destinationToken);
    }

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

  private async getBlockNumber(): Promise<number> {
    return await this.hubPool.provider.getBlockNumber();
  }
}

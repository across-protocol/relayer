import { spreadEvent, assign, Contract, BigNumber, toBN } from "./utils";
import { Deposit, Fill, SpeedUp } from "./interfaces/SpokePool";

export class SpokePoolEventClient {
  private deposits: { [DestinationChainId: number]: Deposit[] } = {};
  private fills: { [DestinationChainId: number]: Fill[] } = {};
  private speedUps: { [DestinationChainId: number]: SpeedUp[] } = {};

  public firstBlockToSearch: number;

  constructor(
    readonly spokePool: Contract,
    readonly chainId: number,
    readonly startingBlock: number = 0,
    readonly endingBlock: number | null = null
  ) {
    this.firstBlockToSearch = startingBlock;
  }

  getDepositsForDestinationChain(destinationChainId: number) {
    return this.deposits[destinationChainId] || [];
  }

  getDepositsFromDepositor(depositor: string) {
    return Object.values(this.deposits)
      .flat()
      .filter((deposit: Deposit) => deposit.depositor === depositor);
  }

  getFillsForDestinationChain(destinationChainId: number) {
    return this.fills[destinationChainId] || [];
  }

  getFillsForOriginChain(originChainId: number) {
    return Object.values(this.fills)
      .flat()
      .filter((fill: Fill) => fill.originChainId === originChainId);
  }

  getFillsForRelayer(relayer: string) {
    return Object.values(this.fills)
      .flat()
      .filter((fill: Fill) => fill.relayer === relayer);
  }

  getUnfilledAmountForDeposit(deposit: Deposit) {
    const fills = this.getFillsForOriginChain(deposit.originChainId)
      .filter((fill) => fill.depositId === deposit.depositId) // Only select the associated fill for the deposit.
      .filter((fill) => this.validateFillForDeposit(fill, deposit)); // Validate that the fill was valid for the deposit.

    if (!fills.length) return deposit.amount; // If no fills then the full amount is remaining.
    return deposit.amount.sub(fills.reduce((total: BigNumber, fill: Fill) => total.add(fill.fillAmount), toBN(0)));
  }

  validateFillForDeposit(fill: Fill, deposit: Deposit) {
    // TODO: the method below does not consider one component of a fill: the realizedLpFeePct. This should be validated
    // through a separate async method method.
    // TODO: This method also does not validate the destinationToken specified in the fill. This needs to be done once
    // we have implemented the HubPoolEventClient.
    // Ensure that each deposit element is included with the same value in the fill. Ignore elements in the deposit
    // that are not included in the fill, such as quoteTimeStamp or originToken.
    let isValid = true;
    Object.keys(deposit).forEach((key) => {
      if (fill[key] && fill[key].toString() !== deposit[key].toString()) isValid = false;
    });

    return isValid;
  }

  async update() {
    const searchConfig = [this.firstBlockToSearch, this.endingBlock || (await this.getBlockNumber())];
    if (searchConfig[0] > searchConfig[1]) return; // If the starting block is greater than the ending block return.

    const [depositEvents, speedUpEvents, fillEvents] = await Promise.all([
      await this.spokePool.queryFilter(this.spokePool.filters.FundsDeposited(), ...searchConfig),
      await this.spokePool.queryFilter(this.spokePool.filters.RequestedSpeedUpDeposit(), ...searchConfig),
      await this.spokePool.queryFilter(this.spokePool.filters.FilledRelay(), ...searchConfig),
    ]);

    for (const event of depositEvents) {
      const augmentedEvent: Deposit = { ...spreadEvent(event), originChainId: this.chainId };
      assign(this.deposits, [augmentedEvent.destinationChainId], [augmentedEvent]);
    }

    for (const event of speedUpEvents) {
      const augmentedEvent: Deposit = { ...spreadEvent(event), originChainId: this.chainId };
      assign(this.speedUps, [augmentedEvent.destinationChainId], [augmentedEvent]);
    }

    for (const event of fillEvents) {
      const augmentedEvent: Deposit = { ...spreadEvent(event), destinationChainId: this.chainId };
      assign(this.fills, [augmentedEvent.destinationChainId], [augmentedEvent]);
    }

    this.firstBlockToSearch = searchConfig[1] + 1; // Next iteration should start off from where this one ended.
  }

  private async getBlockNumber(): Promise<number> {
    return await this.spokePool.provider.getBlockNumber();
  }
}

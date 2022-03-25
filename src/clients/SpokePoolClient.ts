import { RateModelClient } from "./RateModelClient";
import { spreadEvent, assign, Contract, BigNumber, toBN, Event, zeroAddress } from "../utils";
import { Deposit, Fill, SpeedUp } from "../interfaces/SpokePool";

export class SpokePoolClient {
  private deposits: { [DestinationChainId: number]: Deposit[] } = {};
  private fills: { [DestinationChainId: number]: Fill[] } = {};
  private speedUps: { [DestinationChainId: number]: SpeedUp[] } = {};

  public firstBlockToSearch: number;

  constructor(
    readonly spokePool: Contract,
    readonly rateModelClient: RateModelClient | null, // RateModelStore can be excluded. This disables some deposit validation.
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

  getValidUnfilledAmountForDeposit(deposit: Deposit) {
    const fills = this.getFillsForOriginChain(deposit.originChainId)
      .filter((fill) => fill.depositId === deposit.depositId) // Only select the associated fill for the deposit.
      .filter((fill) => this.validateFillForDeposit(fill, deposit)); // Validate that the fill was valid for the deposit.

    if (!fills.length) return deposit.amount; // If no fills then the full amount is remaining.
    return deposit.amount.sub(fills.reduce((total: BigNumber, fill: Fill) => total.add(fill.fillAmount), toBN(0)));
  }

  validateFillForDeposit(fill: Fill, deposit: Deposit) {
    // Ensure that each deposit element is included with the same value in the fill. This verifies:

    let isValid = true;
    Object.keys(deposit).forEach((key) => {
      if (fill[key] && fill[key].toString() !== deposit[key].toString()) {
        isValid = false;
      }
    });

    return isValid;
  }

  async update() {
    const searchConfig = [this.firstBlockToSearch, this.endingBlock || (await this.getBlockNumber())];
    if (searchConfig[0] > searchConfig[1]) return; // If the starting block is greater than the ending block return.

    const [depositEvents, speedUpEvents, fillEvents] = await Promise.all([
      this.spokePool.queryFilter(this.spokePool.filters.FundsDeposited(), ...searchConfig),
      this.spokePool.queryFilter(this.spokePool.filters.RequestedSpeedUpDeposit(), ...searchConfig),
      this.spokePool.queryFilter(this.spokePool.filters.FilledRelay(), ...searchConfig),
    ]);

    // For each depositEvent, compute the realizedLpFeePct. Note this means that we are only finding this value on the
    // new deposits that were found in the searchConfig (new from the previous run). This is important as this operation
    // is heavy as there is a fair bit of block number lookups that need to happen. Note this call REQUIRES that the
    // hubPoolClient is updated on the first before this call as this needed the the L1 token mapping to each L2 token.
    const realizedLpFeePcts = await Promise.all(depositEvents.map((event) => this.computeRealizedLpFeePct(event)));

    for (const [index, event] of depositEvents.entries()) {
      const deposit: Deposit = { ...spreadEvent(event), realizedLpFeePct: realizedLpFeePcts[index] };
      deposit.destinationToken = this.getDestinationTokenForDeposit(deposit); // Append the destination token to the deposit.
      assign(this.deposits, [deposit.destinationChainId], [deposit]);
    }

    for (const event of speedUpEvents) {
      const speedUp: SpeedUp = { ...spreadEvent(event), originChainId: this.chainId };
      // assign(this.speedUps, [speedUp.destinationChainId], [speedUp]); todo: add associated reverse lookup for this.
    }

    for (const event of fillEvents) assign(this.fills, [event.args.destinationChainId], [spreadEvent(event)]);

    this.firstBlockToSearch = searchConfig[1] + 1; // Next iteration should start off from where this one ended.
  }

  private async getBlockNumber(): Promise<number> {
    return await this.spokePool.provider.getBlockNumber();
  }

  private async computeRealizedLpFeePct(depositEvent: Event) {
    if (!this.rateModelClient) return toBN(0); // If there is no rate model client return 0.
    const deposit = {
      amount: depositEvent.args.amount,
      originChainId: Number(depositEvent.args.originChainId),
      originToken: depositEvent.args.originToken,
      quoteTimestamp: depositEvent.args.quoteTimestamp,
    } as Deposit;

    return this.rateModelClient.computeRealizedLpFeePct(deposit, this.hubPoolClient().getL1TokenForDeposit(deposit));
  }

  private getDestinationTokenForDeposit(deposit: Deposit): string {
    if (!this.rateModelClient) return zeroAddress; // If there is no rate model client return address(0).
    return this.hubPoolClient().getDestinationTokenForDeposit(deposit);
  }

  private hubPoolClient() {
    return this.rateModelClient.hubPoolClient;
  }
}

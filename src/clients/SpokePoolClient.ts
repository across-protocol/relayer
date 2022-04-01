import { spreadEvent, assign, Contract, BigNumber, toBN, Event, zeroAddress, winston } from "../utils";
import { RateModelClient } from "./RateModelClient";
import { Deposit, Fill, SpeedUp } from "../interfaces/SpokePool";

export class SpokePoolClient {
  private deposits: { [DestinationChainId: number]: Deposit[] } = {};
  private fills: { [DestinationChainId: number]: Fill[] } = {};
  private speedUps: { [depositorAddress: string]: { [depositId: number]: SpeedUp[] } } = {};

  public firstBlockToSearch: number;

  constructor(
    readonly logger: winston.Logger,
    readonly spokePool: Contract,
    readonly rateModelClient: RateModelClient | null, // RateModelStore can be excluded. This disables some deposit validation.
    readonly chainId: number,
    readonly startingBlock: number = 0,
    readonly endingBlock: number | null = null
  ) {
    this.firstBlockToSearch = startingBlock;
    this.chainId;
  }

  getDepositsForDestinationChain(destinationChainId: number) {
    return this.deposits[destinationChainId] || [];
  }

  getDepositsFromDepositor(depositor: string) {
    return Object.values(this.deposits)
      .flat()
      .filter((deposit: Deposit) => deposit.depositor === depositor); // Select only deposits where the depositor is the same.
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

  appendMaxSpeedUpSignatureToDeposit(deposit: Deposit) {
    const maxSpeedUp = this.speedUps[deposit.depositor]?.[deposit.depositId].reduce((prev, current) =>
      prev.newRelayerFeePct.gt(current.newRelayerFeePct) ? prev : current
    );

    // Only if there is a speedup and the new relayer fee is greater than the current relayer fee, replace the fee.
    if (!maxSpeedUp || maxSpeedUp.newRelayerFeePct.lte(deposit.relayerFeePct)) return deposit;
    return { ...deposit, speedUpSignature: maxSpeedUp.depositorSignature, relayerFeePct: maxSpeedUp.newRelayerFeePct };
  }

  getValidUnfilledAmountForDeposit(deposit: Deposit) {
    const fills = this.getFillsForOriginChain(deposit.originChainId)
      .filter((fill) => fill.depositId === deposit.depositId) // Only select the associated fill for the deposit.
      .filter((fill) => this.validateFillForDeposit(fill, deposit)); // Validate that the fill was valid for the deposit.

    if (!fills.length) return deposit.amount; // If no fills then the full amount is remaining.
    return deposit.amount.sub(fills.reduce((total: BigNumber, fill: Fill) => total.add(fill.fillAmount), toBN(0)));
  }

  // Ensure that each deposit element is included with the same value in the fill. This includes all elements defined
  // by the depositor as well as the realizedLpFeePct and the destinationToken, which are pulled from other clients.
  validateFillForDeposit(fill: Fill, deposit: Deposit) {
    let isValid = true;
    Object.keys(deposit).forEach((key) => {
      if (fill[key] && deposit[key].toString() !== fill[key].toString()) {
        this.log("debug", "Prop mismatch!", { depositVal: deposit[key].toString(), fillValue: fill[key].toString() });
        isValid = false;
      }
    });
    return isValid;
  }

  async update() {
    if (this.rateModelClient !== null && !this.rateModelClient.isUpdated()) throw new Error("RateModel not updated");

    const searchConfig = [this.firstBlockToSearch, this.endingBlock || (await this.getBlockNumber())];
    this.log("debug", "Updating client", { searchConfig, spokePool: this.spokePool.address });
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
    if (depositEvents.length > 0) this.log("debug", "Fetching realizedLpFeePct", { count: depositEvents.length });
    const realizedLpFeePcts = await Promise.all(depositEvents.map((event) => this.computeRealizedLpFeePct(event)));

    for (const [index, event] of depositEvents.entries()) {
      const deposit: Deposit = { ...spreadEvent(event), realizedLpFeePct: realizedLpFeePcts[index] }; // Append the realizedLpFeePct.
      deposit.destinationToken = this.getDestinationTokenForDeposit(deposit); // Append the destination token to the deposit.
      assign(this.deposits, [deposit.destinationChainId], [deposit]);
    }

    for (const event of speedUpEvents) {
      const speedUp: SpeedUp = { ...spreadEvent(event), originChainId: this.chainId };
      assign(this.speedUps, [speedUp.depositor, speedUp.depositId], [speedUp]);
    }

    // Traverse all deposit events and update them with associated speedups, If they exist.
    for (const destinationChainId of Object.keys(this.deposits))
      for (const [index, deposit] of this.deposits[destinationChainId].entries()) {
        const speedUpDeposit = this.appendMaxSpeedUpSignatureToDeposit(deposit);
        if (speedUpDeposit !== deposit) this.deposits[destinationChainId][index] = speedUpDeposit;
      }

    for (const event of fillEvents) assign(this.fills, [event.args.destinationChainId], [spreadEvent(event)]);

    this.firstBlockToSearch = searchConfig[1] + 1; // Next iteration should start off from where this one ended.

    this.log("debug", "Client updated!");
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

  private log(level: string, message: string, data?: any) {
    this.logger[level]({ at: "SpokePoolClient", chainId: this.chainId, message, ...data });
  }
}

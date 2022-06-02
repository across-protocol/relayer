import { spreadEvent, assign, Contract, BigNumber, EventSearchConfig, Promise } from "../utils";
import { toBN, Event, ZERO_ADDRESS, winston, paginatedEventQuery, spreadEventWithBlockNumber } from "../utils";

import { AcrossConfigStoreClient } from "./ConfigStoreClient";
import { Deposit, DepositWithBlock, Fill, SpeedUp, FillWithBlock, TokensBridged } from "../interfaces/SpokePool";
import { RootBundleRelayWithBlock, RelayerRefundExecutionWithBlock } from "../interfaces/SpokePool";

export class SpokePoolClient {
  private deposits: { [DestinationChainId: number]: Deposit[] } = {};
  private fills: Fill[] = [];
  private speedUps: { [depositorAddress: string]: { [depositId: number]: SpeedUp[] } } = {};
  private depositRoutes: { [originToken: string]: { [DestinationChainId: number]: boolean } } = {};
  private tokensBridged: TokensBridged[] = [];
  private rootBundleRelays: RootBundleRelayWithBlock[] = [];
  private relayerRefundExecutions: RelayerRefundExecutionWithBlock[] = [];
  public isUpdated: boolean = false;

  public firstBlockToSearch: number;
  public latestBlockNumber: number;
  public fillsWithBlockNumbers: FillWithBlock[] = [];
  public depositsWithBlockNumbers: { [DestinationChainId: number]: DepositWithBlock[] } = {};

  constructor(
    readonly logger: winston.Logger,
    readonly spokePool: Contract,
    readonly configStoreClient: AcrossConfigStoreClient | null, // Can be excluded. This disables some deposit validation.
    readonly chainId: number,
    readonly eventSearchConfig: EventSearchConfig = { fromBlock: 0, toBlock: null, maxBlockLookBack: 0 },
    readonly spokePoolDeploymentBlock: number = 0
  ) {
    this.firstBlockToSearch = eventSearchConfig.fromBlock;
  }

  getDepositsForDestinationChain(destinationChainId: number, withBlock = false): Deposit[] | DepositWithBlock[] {
    return withBlock
      ? this.depositsWithBlockNumbers[destinationChainId] || []
      : this.deposits[destinationChainId] || [];
  }

  getDepositsFromDepositor(depositor: string): Deposit[] {
    return Object.values(this.deposits)
      .flat()
      .filter((deposit: Deposit) => deposit.depositor === depositor); // Select only deposits where the depositor is the same.
  }

  getFills(): Fill[] {
    return this.fills;
  }

  getTokensBridged(): TokensBridged[] {
    return this.tokensBridged;
  }

  getDepositRoutes(): { [originToken: string]: { [DestinationChainId: number]: Boolean } } {
    return this.depositRoutes;
  }

  isDepositRouteEnabled(originToken: string, destinationChainId: number): boolean {
    return this.depositRoutes[originToken]?.[destinationChainId] ?? false;
  }

  getAllOriginTokens(): string[] {
    return Object.keys(this.depositRoutes);
  }

  getFillsForOriginChain(originChainId: number): Fill[] {
    return this.fills.filter((fill: Fill) => fill.originChainId === originChainId);
  }

  getFillsWithBlockForOriginChain(originChainId: number): FillWithBlock[] {
    return this.fillsWithBlockNumbers.filter((fill: Fill) => fill.originChainId === originChainId);
  }

  getFillsForRepaymentChain(repaymentChainId: number) {
    return this.fills.filter((fill: Fill) => fill.repaymentChainId === repaymentChainId);
  }

  getFillsForRelayer(relayer: string) {
    return this.fills.filter((fill: Fill) => fill.relayer === relayer);
  }

  getRootBundleRelays() {
    return this.rootBundleRelays;
  }

  getRelayerRefundExecutions() {
    return this.relayerRefundExecutions;
  }

  appendMaxSpeedUpSignatureToDeposit(deposit: Deposit) {
    const maxSpeedUp = this.speedUps[deposit.depositor]?.[deposit.depositId].reduce((prev, current) =>
      prev.newRelayerFeePct.gt(current.newRelayerFeePct) ? prev : current
    );

    // Only if there is a speedup and the new relayer fee is greater than the current relayer fee, replace the fee.
    if (!maxSpeedUp || maxSpeedUp.newRelayerFeePct.lte(deposit.relayerFeePct)) return deposit;
    return { ...deposit, speedUpSignature: maxSpeedUp.depositorSignature, relayerFeePct: maxSpeedUp.newRelayerFeePct };
  }

  getDepositForFill(fill: Fill): Deposit | undefined {
    const { blockNumber, ...fillCopy } = fill as FillWithBlock; // Ignore blockNumber when validating the fill.
    return this.getDepositsForDestinationChain(fillCopy.destinationChainId).find((deposit) => {
      if (fillCopy.depositId !== deposit.depositId) return false;
      return this.validateFillForDeposit(fillCopy, deposit);
    });
  }

  getValidUnfilledAmountForDeposit(deposit: Deposit): { unfilledAmount: BigNumber; fillCount: number } {
    const fills = this.getFillsForOriginChain(deposit.originChainId)
      .filter((fill) => fill.depositId === deposit.depositId) // Only select the associated fill for the deposit.
      .filter((fill) => this.validateFillForDeposit(fill, deposit)); // Validate that the fill was valid for the deposit.

    if (fills.length === 0) return { unfilledAmount: toBN(deposit.amount), fillCount: 0 }; // If no fills then the full amount is remaining.

    // Order fills by totalFilledAmount and then return the first fill's full deposit amount minus total filled amount.
    const fillsOrderedByTotalFilledAmount = fills.sort((fillA, fillB) =>
      fillB.totalFilledAmount.gt(fillA.totalFilledAmount)
        ? 1
        : fillB.totalFilledAmount.lt(fillA.totalFilledAmount)
        ? -1
        : 0
    );
    const lastFill = fillsOrderedByTotalFilledAmount[0];
    return { unfilledAmount: toBN(lastFill.amount.sub(lastFill.totalFilledAmount)), fillCount: fills.length };
  }

  // Ensure that each deposit element is included with the same value in the fill. This includes all elements defined
  // by the depositor as well as the realizedLpFeePct and the destinationToken, which are pulled from other clients.
  validateFillForDeposit(fill: Fill, deposit: Deposit) {
    let isValid = true;
    Object.keys(deposit).forEach((key) => {
      if (fill[key] !== undefined && deposit[key].toString() !== fill[key].toString()) isValid = false;
    });
    return isValid;
  }

  async update() {
    if (this.configStoreClient !== null && !this.configStoreClient.isUpdated) throw new Error("RateModel not updated");

    this.latestBlockNumber = await this.spokePool.provider.getBlockNumber();
    const searchConfig = {
      fromBlock: this.firstBlockToSearch,
      toBlock: this.eventSearchConfig.toBlock || this.latestBlockNumber,
      maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
    };

    // Deposit route search config should always go from the deployment block to ensure we fetch all routes. If this is
    // the first run then set the from block to the deployment block of the spoke pool. Else, use the same config as the
    // other event queries to not double search over the same event ranges.
    const depositRouteSearchConfig = { ...searchConfig }; // shallow copy.
    if (!this.isUpdated) depositRouteSearchConfig.fromBlock = this.spokePoolDeploymentBlock;

    this.log("debug", `Updating SpokePool client for chain ${this.chainId}`, {
      searchConfig,
      depositRouteSearchConfig,
      spokePool: this.spokePool.address,
    });
    if (searchConfig.fromBlock > searchConfig.toBlock) return; // If the starting block is greater than the ending block return.

    const [
      depositEvents,
      speedUpEvents,
      fillEvents,
      enableDepositsEvents,
      tokensBridgedEvents,
      relayedRootBundleEvents,
      executedRelayerRefundRootEvents,
    ] = await Promise.all(
      [
        paginatedEventQuery(this.spokePool, this.spokePool.filters.FundsDeposited(), searchConfig),
        paginatedEventQuery(this.spokePool, this.spokePool.filters.RequestedSpeedUpDeposit(), searchConfig),
        paginatedEventQuery(this.spokePool, this.spokePool.filters.FilledRelay(), searchConfig),
        paginatedEventQuery(this.spokePool, this.spokePool.filters.EnabledDepositRoute(), depositRouteSearchConfig),
        paginatedEventQuery(this.spokePool, this.spokePool.filters.TokensBridged(), depositRouteSearchConfig),
        paginatedEventQuery(this.spokePool, this.spokePool.filters.RelayedRootBundle(), searchConfig),
        paginatedEventQuery(this.spokePool, this.spokePool.filters.ExecutedRelayerRefundRoot(), searchConfig),
      ],
      { concurrency: 2 }
    );

    for (const event of tokensBridgedEvents) {
      this.tokensBridged.push({ ...spreadEvent(event), transactionHash: event.transactionHash });
    }

    // For each depositEvent, compute the realizedLpFeePct. Note this means that we are only finding this value on the
    // new deposits that were found in the searchConfig (new from the previous run). This is important as this operation
    // is heavy as there is a fair bit of block number lookups that need to happen. Note this call REQUIRES that the
    // hubPoolClient is updated on the first before this call as this needed the the L1 token mapping to each L2 token.
    if (depositEvents.length > 0)
      this.log("debug", `Fetching realizedLpFeePct for ${depositEvents.length} deposits on chain ${this.chainId}`, {
        numDeposits: depositEvents.length,
      });
    const dataForQuoteTime: { realizedLpFeePct: BigNumber; quoteBlock: number }[] = await Promise.all(
      depositEvents.map((event) => this.computeRealizedLpFeePct(event))
    );

    for (const [index, event] of depositEvents.entries()) {
      // Append the realizedLpFeePct.
      const deposit: Deposit = { ...spreadEvent(event), realizedLpFeePct: dataForQuoteTime[index].realizedLpFeePct };
      // Append the destination token to the deposit.
      deposit.destinationToken = this.getDestinationTokenForDeposit(deposit);
      assign(this.deposits, [deposit.destinationChainId], [deposit]);
      assign(
        this.depositsWithBlockNumbers,
        [deposit.destinationChainId],
        [{ ...deposit, blockNumber: dataForQuoteTime[index].quoteBlock, originBlockNumber: event.blockNumber }]
      );
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

    for (const event of fillEvents) {
      this.fills.push(spreadEvent(event));
      this.fillsWithBlockNumbers.push(spreadEventWithBlockNumber(event) as FillWithBlock);
    }

    for (const event of enableDepositsEvents) {
      const enableDeposit = spreadEvent(event);
      assign(this.depositRoutes, [enableDeposit.originToken, enableDeposit.destinationChainId], enableDeposit.enabled);
    }

    for (const event of relayedRootBundleEvents) {
      this.rootBundleRelays.push(spreadEventWithBlockNumber(event) as RootBundleRelayWithBlock);
    }

    for (const event of executedRelayerRefundRootEvents) {
      this.relayerRefundExecutions.push(spreadEvent(event));
    }

    this.firstBlockToSearch = searchConfig.toBlock + 1; // Next iteration should start off from where this one ended.

    this.isUpdated = true;
    this.log("debug", `SpokePool client for chain ${this.chainId} updated!`, searchConfig);
  }

  public hubPoolClient() {
    return this.configStoreClient.hubPoolClient;
  }

  private async computeRealizedLpFeePct(depositEvent: Event) {
    if (!this.configStoreClient) return { realizedLpFeePct: toBN(0), quoteBlock: 0 }; // If there is no rate model client return 0.
    const deposit = {
      amount: depositEvent.args.amount,
      originChainId: Number(depositEvent.args.originChainId),
      originToken: depositEvent.args.originToken,
      quoteTimestamp: depositEvent.args.quoteTimestamp,
    } as Deposit;

    return this.configStoreClient.computeRealizedLpFeePct(deposit, this.hubPoolClient().getL1TokenForDeposit(deposit));
  }

  private getDestinationTokenForDeposit(deposit: Deposit): string {
    if (!this.configStoreClient) return ZERO_ADDRESS; // If there is no rate model client return address(0).
    return this.hubPoolClient().getDestinationTokenForDeposit(deposit);
  }

  private log(level: string, message: string, data?: any) {
    this.logger[level]({ at: "SpokePoolClient", chainId: this.chainId, message, ...data });
  }
}

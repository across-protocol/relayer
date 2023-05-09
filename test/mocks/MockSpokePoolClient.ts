import { random } from "lodash";
import { SpokePoolClient, SpokePoolUpdate } from "../../src/clients";
import { DepositWithBlock, FillWithBlock, RefundRequestWithBlock } from "../../src/interfaces";
import { Event } from "../../src/utils";
import { Contract, randomAddress, toBN, toBNWei, winston } from "../utils";
import { EventManager } from "./MockEvents";

// This class replaces internal SpokePoolClient functionality, enabling the
// user to bypass on-chain queries and inject ethers Event objects directly.
export class MockSpokePoolClient extends SpokePoolClient {
  private events: Event[] = [];
  public readonly minBlockRange = 10;
  // Allow tester to set the numberOfDeposits() returned by SpokePool at a block height.
  public depositIdAtBlock: number[] = [];
  private eventManager: EventManager;

  constructor(logger: winston.Logger, spokePool: Contract, chainId: number, deploymentBlock: number) {
    super(logger, spokePool, null, chainId, deploymentBlock);
    this.latestBlockNumber = deploymentBlock;
    this.eventManager = new EventManager(this.eventSignatures);
  }

  addEvent(event: Event): void {
    this.events.push(event);
  }

  setDepositIds(_depositIds: number[]): void {
    this.depositIdAtBlock = [];
    if (_depositIds.length === 0) {
      return;
    }
    let lastDepositId = _depositIds[0];
    for (let i = 0; i < _depositIds.length; i++) {
      if (_depositIds[i] < lastDepositId) {
        throw new Error("deposit ID must be equal to or greater than previous");
      }
      this.depositIdAtBlock[i] = _depositIds[i];
      lastDepositId = _depositIds[i];
    }
  }

  async _getDepositIdAtBlock(blockTag: number): Promise<number> {
    return this.depositIdAtBlock[blockTag];
  }

  override async _update(eventsToQuery: string[]): Promise<SpokePoolUpdate> {
    // Temporarily append "RefundRequested" to the eventsToQuery array.
    // @todo: Remove when the SpokePoolClient supports querying this directly.
    eventsToQuery.push("RefundRequested");

    // Generate new "on chain" responses.
    const latestBlockNumber = this.latestBlockNumber + random(this.minBlockRange, this.minBlockRange * 5, false);
    const currentTime = Math.floor(Date.now() / 1000);

    // Ensure an array for every requested event exists, in the requested order.
    // All requested event types must be populated in the array (even if empty).
    const events: Event[][] = eventsToQuery.map(() => []);
    this.events.flat().forEach((event) => {
      const idx = eventsToQuery.indexOf(event.event as string);
      if (idx !== -1) {
        events[idx].push(event);
      }
    });
    this.events = [];

    // Update latestDepositIdQueried.
    const idx = eventsToQuery.indexOf("FundsDeposited");
    const latestDepositId = (events[idx] ?? []).reduce(
      (depositId, event) => Math.max(depositId, event["depositId"]),
      this.latestDepositIdQueried
    );

    return {
      success: true,
      firstDepositId: 0,
      latestBlockNumber,
      latestDepositId,
      currentTime,
      events,
      searchEndBlock: this.eventSearchConfig.toBlock || latestBlockNumber,
    };
  }

  // Event signatures. Not strictly required, but they make generated events more recognisable.
  public readonly eventSignatures: Record<string, string> = {
    EnabledDepositRoute: "address,uint256,bool",
    FilledRelay: "uint256,uint256,uint256,int64,uint32,uint32,address,address,address,bytes",
    FundsDeposited: "uint256,uint256,uint256,int64,uint32,uint32,address,address,address,bytes",
    RefundRequested: "address,address,uint256,uint256,uint256,int64,uint32,uint256,uint256",
  };

  generateDeposit(deposit: DepositWithBlock): Event {
    const event = "FundsDeposited";

    const { depositId, blockNumber, transactionIndex } = deposit;
    let { depositor, destinationChainId } = deposit;
    destinationChainId ??= random(1, 42161, false);
    depositor ??= randomAddress();

    const message = deposit["message"] ?? `${event} event at block ${blockNumber}, index ${transactionIndex}.`;
    const topics = [destinationChainId, depositId, depositor];
    const args = {
      amount: deposit.amount ?? toBNWei(random(1, 1000, false)),
      originChainId: deposit.originChainId ?? this.chainId,
      destinationChainId,
      relayerFeePct: deposit.relayerFeePct ?? toBNWei(0.0001),
      depositId,
      quoteTimestamp: deposit.quoteTimestamp ?? Math.floor(Date.now() / 1000),
      originToken: deposit.originToken ?? randomAddress(),
      recipient: deposit.recipient ?? depositor,
      depositor,
      message,
    };

    return this.eventManager.generateEvent({
      event,
      address: this.spokePool.address,
      topics: topics.map((topic) => topic.toString()),
      args,
      blockNumber,
      transactionIndex,
    });
  }

  generateFill(fill: FillWithBlock): Event {
    const event = "FilledRelay";

    const { blockNumber, transactionIndex } = fill;
    let { depositor, originChainId, depositId } = fill;
    originChainId ??= random(1, 42161, false);
    depositId ??= random(1, 100_000, false);
    depositor ??= randomAddress();

    const topics = [originChainId, depositId, depositor];
    const recipient = fill.recipient ?? randomAddress();
    const amount = fill.amount ?? toBNWei(random(1, 1000, false));
    const relayerFeePct = fill.relayerFeePct ?? toBNWei(0.0001);
    const message = fill["message"] ?? `${event} event at block ${blockNumber}, index ${transactionIndex}.`;

    const args = {
      amount,
      totalFilledAmount: fill.totalFilledAmount ?? amount,
      fillAmount: fill.fillAmount ?? amount,
      repaymentChainId: fill.repaymentChainId ?? this.chainId,
      originChainId,
      destinationChainId: fill.destinationChainId,
      realizedLpFeePct: fill.realizedLpFeePct ?? toBNWei(random(0.00001, 0.0001).toPrecision(6)),
      relayerFeePct,
      depositId,
      destinationToken: randomAddress(),
      relayer: fill.relayer ?? randomAddress(),
      depositor,
      recipient,
      message,
      updatableRelayData: {
        recipient: fill.updatableRelayData?.recipient ?? recipient,
        message: fill.updatableRelayData?.message ?? message,
        relayerFeePct: fill.updatableRelayData?.relayerFeePct ?? relayerFeePct,
        isSlowRelay: fill.updatableRelayData?.isSlowRelay ?? false,
        payoutAdjustmentPct: fill.updatableRelayData?.payoutAdjustmentPct ?? toBN(0),
      },
    };

    return this.eventManager.generateEvent({
      event,
      address: this.spokePool.address,
      topics: topics.map((topic) => topic.toString()),
      args,
      blockNumber,
      transactionIndex,
    });
  }

  generateRefundRequest(request: RefundRequestWithBlock): Event {
    const event = "RefundRequested";

    const { blockNumber, transactionIndex } = request;
    let { relayer, originChainId, depositId } = request;

    relayer ??= randomAddress();
    originChainId ??= random(1, 42161, false);
    depositId ??= random(1, 100_000, false);

    const topics = [relayer, originChainId, depositId];
    const args = {
      relayer,
      refundToken: request.refundToken ?? randomAddress(),
      amount: request.amount ?? toBNWei(random(1, 1000, false)),
      originChainId,
      destinationChainId: request.destinationChainId ?? random(1, 42161, false),
      realizedLpFeePct: request.realizedLpFeePct ?? toBNWei(random(0.00001, 0.0001).toPrecision(6)),
      depositId,
      fillBlock: request.fillBlock ?? random(1, 1000, false),
      previousIdenticalRequests: request.previousIdenticalRequests ?? "0",
    };

    return this.eventManager.generateEvent({
      event,
      address: this.spokePool.address,
      topics: topics.map((topic) => topic.toString()),
      args,
      blockNumber,
      transactionIndex,
    });
  }

  generateDepositRoute(originToken: string, destinationChainId: number, enabled: boolean): Event {
    const event = "EnabledDepositRoute";

    const topics = [originToken, destinationChainId];
    const args = { originToken, destinationChainId, enabled };

    return this.eventManager.generateEvent({
      event,
      address: this.spokePool.address,
      topics: topics.map((topic) => topic.toString()),
      args,
      blockNumber: this.latestBlockNumber + 1,
    });
  }
}

import { random } from "lodash";
import { SpokePoolClient, SpokePoolUpdate } from "../../src/clients";
import { DepositWithBlock, FillWithBlock, RefundRequestWithBlock } from "../../src/interfaces";
import { BigNumberish, Event } from "../../src/utils";
import { Contract, ethers, randomAddress, toBNWei, winston } from "../utils";

export type EthersEventTemplate = {
  address: string;
  event: string;
  topics: string[];
  args: Record<string, boolean | BigNumberish | string>;
  data?: string;
  blockNumber?: number;
  transactionIndex?: number;
};

type Block = ethers.providers.Block;
type TransactionResponse = ethers.providers.TransactionResponse;
type TransactionReceipt = ethers.providers.TransactionReceipt;

// This class replaces internal SpokePoolClient functionality, enabling the
// user to bypass on-chain queries and inject ethers Event objects directly.
export class MockSpokePoolClient extends SpokePoolClient {
  private events: Event[] = [];
  public readonly minBlockRange = 10;
  private logIndexes: Record<string, number> = {};
  // Allow tester to set the numberOfDeposits() returned by SpokePool at a block height.
  public depositIdAtBlock: number[] = [];

  constructor(logger: winston.Logger, spokePool: Contract, chainId: number, deploymentBlock: number) {
    super(logger, spokePool, null, chainId, deploymentBlock);
    this.latestBlockNumber = deploymentBlock;
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
    const currentTime = Date.now() / 1000;

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

  // Partial event signatures. Not strictly required, but they make generated events more recognisable.
  // @todo: Source these from contracts-v2, when available.
  public readonly eventSignatures: Record<string, string> = {
    FundsDeposited: "uint256,uint256,uint256,int64,uint32,uint32,address,address,address,bytes",
    FilledRelay: "uint256,uint256,uint256,int64,uint32,uint32,address,address,address,bytes",
    RefundRequested: "address,address,uint256,uint256,uint256,int64,uint32,uint256,uint256",
  };

  // Event topic. Not strictly required, but they make generated events more recognisable.
  // @todo: Source these from contracts-v2, when available.
  public readonly topics: Record<string, string> = {
    FundsDeposited: "XXX",
    FilledRelay: "XXX",
    RefundRequested: "XXX",
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

    return this.generateEvent({
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
    const amount = fill.amount ?? toBNWei(random(1, 1000, false));
    const message = fill["message"] ?? `${event} event at block ${blockNumber}, index ${transactionIndex}.`;

    const args = {
      amount,
      totalFilledAmount: fill.totalFilledAmount ?? amount,
      fillAmount: fill.fillAmount ?? amount,
      repaymentChainId: fill.repaymentChainId ?? this.chainId,
      originChainId,
      destinationChainId: fill.destinationChainId,
      realizedLpFeePct: fill.realizedLpFeePct ?? toBNWei(random(0.00001, 0.0001).toPrecision(6)),
      depositId,
      destinationToken: randomAddress(),
      relayer: fill.relayer ?? randomAddress(),
      depositor,
      recipient: randomAddress(),
      isSlowRelay: fill.isSlowRelay ?? false,
      message,
      // updatableRelayData @todo: New ABI needed
    };

    return this.generateEvent({
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

    return this.generateEvent({
      event,
      address: this.spokePool.address,
      topics: topics.map((topic) => topic.toString()),
      args,
      blockNumber,
      transactionIndex,
    });
  }

  generateEvent(inputs: EthersEventTemplate): Event {
    const { address, event, topics, data, args } = inputs;
    let { blockNumber, transactionIndex } = inputs;

    const _logIndex = `${blockNumber}-${transactionIndex}`;
    this.logIndexes[_logIndex] ??= 0;
    const logIndex = this.logIndexes[_logIndex]++;

    // Populate these Event functions, even though they appear unused.
    const getBlock = async (): Promise<Block> => {
      return {} as Block;
    };
    const getTransaction = async (): Promise<TransactionResponse> => {
      return {} as TransactionResponse;
    };
    const getTransactionReceipt = async (): Promise<TransactionReceipt> => {
      return {} as TransactionReceipt;
    };
    const decodeError = new Error(`${event} decoding error`);
    const removeListener = (): void => {
      return;
    };

    blockNumber ??= random(1, 100_000, false);
    transactionIndex ??= random(1, 32, false);
    const transactionHash = ethers.utils.id(
      `Across-v2-${event}-${blockNumber}-${transactionIndex}-${random(1, 100_000)}`
    );

    return {
      blockNumber,
      transactionIndex,
      logIndex,
      transactionHash,
      removed: false,
      address,
      data: data ?? ethers.utils.id(`Across-v2-random-txndata-${random(1, 100_000)}`),
      topics: [this.topics[event]].concat(topics),
      args,
      blockHash: ethers.utils.id(`Across-v2-blockHash-${random(1, 100_000)}`),
      event,
      eventSignature: `${event}(${this.eventSignatures[event]})`,
      decodeError,
      getBlock,
      getTransaction,
      getTransactionReceipt,
      removeListener,
    } as Event;
  }
}

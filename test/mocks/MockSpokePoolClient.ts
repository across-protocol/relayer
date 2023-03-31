import { random } from "lodash";
import { SpokePoolClient, SpokePoolUpdate } from "../../src/clients";
import { Event } from "../../src/utils";
import { Contract, ethers, winston } from "../utils";

export type EthersEventTemplate = {
  address: string;
  topics: string[];
  blockNumber?: string;
  transactionIndex?: string;
  data?: string;
  args?: string[];
  event?: string;
}

type Block = ethers.providers.Block;
type TransactionResponse = ethers.providers.TransactionResponse;
type TransactionReceipt = ethers.providers.TransactionReceipt;

// This class replaces internal SpokePoolClient functionality, enabling the
// user to bypass on-chain queries and inject ethers Event objects directly.
export class MockSpokePoolClient extends SpokePoolClient {

  private events: Event[] = [];
  public readonly minBlockRange = 10;

  constructor(
    logger: winston.Logger,
    spokePool: Contract,
    chainId: number,
    deploymentBlock: number,
  ) {
    super(logger, spokePool, null, chainId, deploymentBlock);
    this.latestBlockNumber = deploymentBlock;
  }

  addEvent(event: Event) {
    this.events.push(event);
  }

  override async _update(eventsToQuery: string[]): Promise<SpokePoolUpdate> {
    // Temporarily append "RefundRequested" to the eventsToQuery array.
    // @todo: Remove when the SpokePoolClient supports querying this directly.
    eventsToQuery.push("RefundRequested");

    // Generate new "on chain" responses.
    const latestBlockNumber = this.latestBlockNumber + random(this.minBlockRange, this.minBlockRange * 5, false);
    const currentTime = Date.now() / 1000;

    // Ensure an array for every requested event exists, in the requested order.
    const events: Event[][] = [];
    this.events.flat().forEach((event) => {
      const idx = eventsToQuery.indexOf(event.event as string);
      if (idx !== -1) {
        events[idx] ??= [];
        events[idx].push(event);
      }
    });

    // Ensure all requested events are populated (even if empty).
    eventsToQuery.forEach((_eventName, idx) => events[idx] ??= []);
    this.events = [];

    // Update latestDepositIdQueried.
    const idx = eventsToQuery.indexOf("FundsDeposited");
    const latestDepositId = (events[idx] ?? [])
      .reduce((depositId, event) => Math.max(depositId, event["depositId"]), this.latestDepositIdQueried);

    return {
      success: true,
      firstDepositId: 0,
      latestBlockNumber,
      latestDepositId,
      currentTime,
      events,
      searchEndBlock:  this.eventSearchConfig.toBlock || latestBlockNumber,
    };
  }

  generateRefundRequest(inputs: EthersEventTemplate): Event {
    // @todo: Source these from contracts-v2, when available.
    const event = "RefundRequested";
    const eventSignature = "RefundRequested(uint256,uint256,uint256,uint256,uint256,int65,uint32,uint256,uint256)";
    const topics = ["XXX"].concat(inputs.topics);

    return this.generateEvent(inputs.address, event, eventSignature, topics, undefined, inputs.args, inputs.blockNumber);
  }

  private generateEvent(
    address: string,
    event: string,
    eventSignature: string,
    topics: string[],
    data?: string,
    args?: string[],
    blockNumber?: string,
    transactionIndex?: number,
  ): Event {
    // Populate these Event functions, even though they appear unused.
    const getBlock = async (): Promise<Block> => { return {} as Block };
    const getTransaction = async (): Promise<TransactionResponse> => { return {} as TransactionResponse };
    const getTransactionReceipt = async (): Promise<TransactionReceipt> => { return {} as TransactionReceipt };
    const decodeError = new Error(`${event} decoding error`);
    const removeListener = (): void => {};

    return {
      blockNumber: blockNumber ?? random(1, 100_000, false),
      transactionIndex: transactionIndex ?? random(1, 32, false),
      removed: false,
      address,
      data: data ?? ethers.utils.id(`Across-v2-random-txndata-${random(1, 100_000)}`),
      topics,
      args,
      transactionHash: ethers.utils.id(`Across-v2-${event}-${random(1, 100_000)}`),
      blockHash: ethers.utils.id(`Across-v2-blockHash-${random(1, 100_000)}`),
      logIndex: 1,
      event,
      eventSignature,
      decodeError,
      getBlock,
      getTransaction,
      getTransactionReceipt,
      removeListener,
    } as Event;
  }
}


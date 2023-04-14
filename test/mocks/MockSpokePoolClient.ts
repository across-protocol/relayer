import { random } from "lodash";
import { SpokePoolClient, SpokePoolUpdate } from "../../src/clients";
import { Event } from "../../src/utils";
import { Contract, ethers, winston } from "../utils";

export type EthersEventTemplate = {
  address: string;
  event: string;
  topics: string[];
  args: Record<string,any>;
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
  // Allow tester to set the numberOfDeposits() returned by SpokePool at a block height.
  public depositIdAtBlock: number[] = [];

  constructor(logger: winston.Logger, spokePool: Contract, chainId: number, deploymentBlock: number) {
    super(logger, spokePool, null, chainId, deploymentBlock);
    this.latestBlockNumber = deploymentBlock;
  }

  addEvent(event: Event) {
    this.events.push(event);
  }

  setDepositIds(_depositIds: number[]) {
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
    const events: Event[][] = [];
    eventsToQuery.forEach((_eventName, idx) => (events[idx] ??= []));
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
  }

  // Event topic. Not strictly required, but they make generated events more recognisable.
  // @todo: Source these from contracts-v2, when available.
  public readonly topics: Record<string, string> = {
    FundsDeposited: "XXX",
    FilledRelay: "XXX",
    RefundRequested: "XXX",
  }

  generateEvent(inputs: EthersEventTemplate): Event {
    const { address, event, topics, data, args } = inputs;
    let { blockNumber, transactionIndex } = inputs;

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
      logIndex: 1,
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

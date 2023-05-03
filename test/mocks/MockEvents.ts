import { random } from "lodash";
import { Event } from "../../src/utils";
import { ethers } from "../utils";

type Block = ethers.providers.Block;
type TransactionResponse = ethers.providers.TransactionResponse;
type TransactionReceipt = ethers.providers.TransactionReceipt;

export type EthersEventTemplate = {
  address: string;
  event: string;
  topics: string[];
  args: Record<string, any>;
  data?: string;
  blockNumber?: number;
  transactionIndex?: number;
};

export class EventManager {
  private logIndexes: Record<string, number> = {};

  constructor(
    public readonly eventSignatures: Record<string, string>,
    public readonly topics: Record<string, string>
  ) {}

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

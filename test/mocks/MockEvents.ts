import { random } from "lodash";
import { Event } from "../../src/utils";
import { ethers } from "../utils";

type Block = ethers.providers.Block;
type TransactionResponse = ethers.providers.TransactionResponse;
type TransactionReceipt = ethers.providers.TransactionReceipt;

type EthersEventTemplate = {
  address: string;
  event: string;
  topics: string[];
  args: Record<string, any>;
  data?: string;
  blockNumber?: number;
  transactionIndex?: number;
};

const getBlock = async (): Promise<Block> => {
  throw new Error("getBlock() not supported");
};
const getTransaction = async (): Promise<TransactionResponse> => {
  throw new Error("getTransaction() not supported");
};
const getTransactionReceipt = async (): Promise<TransactionReceipt> => {
  throw new Error("getTransactionReceipt() not supported");
};
const removeListener = (): void => {
  throw new Error("removeListener not supported");
};

export class EventManager {
  private logIndexes: Record<string, number> = {};

  constructor(public readonly eventSignatures: Record<string, string>) {}

  generateEvent(inputs: EthersEventTemplate): Event {
    const { address, event, topics: _topics, data, args } = inputs;
    const eventSignature = `${event}(${this.eventSignatures[event]})`;
    const topics = [ethers.utils.keccak256(ethers.utils.toUtf8Bytes(eventSignature))].concat(_topics);

    let { blockNumber, transactionIndex } = inputs;

    blockNumber ??= random(1, 100_000, false);
    transactionIndex ??= random(1, 32, false);
    const transactionHash = ethers.utils.id(
      `Across-v2-${event}-${blockNumber}-${transactionIndex}-${random(1, 100_000)}`
    );

    const _logIndex = `${blockNumber}-${transactionIndex}`;
    this.logIndexes[_logIndex] ??= 0;
    const logIndex = this.logIndexes[_logIndex]++;

    const decodeError = new Error(`${event} decoding error`);

    // Populate these Event functions, even though they appear unused.
    return {
      blockNumber,
      transactionIndex,
      logIndex,
      transactionHash,
      removed: false,
      address,
      data: data ?? ethers.utils.id(`Across-v2-random-txndata-${random(1, 100_000)}`),
      topics,
      args,
      blockHash: ethers.utils.id(`Across-v2-blockHash-${random(1, 100_000)}`),
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

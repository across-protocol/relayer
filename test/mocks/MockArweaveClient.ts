import { caching } from "@across-protocol/sdk";
import { Struct } from "superstruct";
import { BigNumber, winston } from "../../src/utils";

type MockArweaveTopicResponse<T> = { data: T; hash: string }[];

export class MockArweaveClient extends caching.ArweaveClient {
  // Map from arweave key to JSON object stored as a string.
  protected cache: { [key: string]: string } = {};
  protected queuedTopicResponses: { [key: string]: string[] } = {};
  protected address = "mock-arweave-address";
  protected balance = BigNumber.from("1000000000000000000");

  readonly getByTopicCalls: { [key: string]: number } = {};
  readonly setCalls: { data: unknown; tag?: string; hash: string }[] = [];

  constructor(arweaveJWT: string, logger: winston.Logger, gatewayURL = "", protocol = "https", port = 443) {
    super(arweaveJWT, logger, gatewayURL, protocol, port);
  }

  async getByTopic<T>(
    tag: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _validator?: Struct<T>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _originQueryAddress?: string
  ): Promise<{ data: T; hash: string }[]> {
    this.getByTopicCalls[tag] = (this.getByTopicCalls[tag] ?? 0) + 1;

    const queuedResponse = this.queuedTopicResponses[tag]?.shift();
    if (queuedResponse !== undefined) {
      return Promise.resolve(JSON.parse(queuedResponse));
    }

    return Promise.resolve(this.cache[tag] ? JSON.parse(this.cache[tag]) : []);
  }

  async getAddress(): Promise<string> {
    return Promise.resolve(this.address);
  }

  async getBalance(): Promise<BigNumber> {
    return Promise.resolve(this.balance);
  }

  async set<T>(data: T, tag?: string): Promise<string> {
    const hash = `mock-arweave-hash-${this.setCalls.length}`;
    this.setCalls.push({ data, tag, hash });

    if (tag !== undefined) {
      this._setCache(tag, [{ data, hash }]);
    }

    return Promise.resolve(hash);
  }

  _queueGetByTopicResponses<T>(key: string, responses: MockArweaveTopicResponse<T>[]) {
    this.queuedTopicResponses[key] = responses.map((response) => JSON.stringify(response));
  }

  _setAddress(address: string) {
    this.address = address;
  }

  _setBalance(balance: BigNumber) {
    this.balance = balance;
  }

  _setCache<T>(key: string, object: T) {
    this.cache[key] = JSON.stringify(object);
  }
}

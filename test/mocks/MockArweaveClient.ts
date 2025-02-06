import { caching } from "@across-protocol/sdk";

export class MockArweaveClient extends caching.ArweaveClient {
  // Map from arweave key to JSON object stored as a string.
  protected cache: { [key: string]: string } = {};

  constructor(arweaveJWT: string, logger: winston.logger, gatewayURL = "", protocol = "https", port = 443) {
    super(arweaveJWT, logger, gatewayURL, protocol, port);
  }

  async getByTopic<T>(
    tag: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _validator?: Struct<T>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _originQueryAddress?: string
  ): Promise<{ data: T; hash: string }[]> {
    return Promise.resolve(JSON.parse(this.cache[tag]));
  }

  _setCache<T>(key: string, object: T) {
    this.cache[key] = JSON.stringify(object);
  }
}

import { array, string, type } from "superstruct";
import { fetchWithTimeout, winston } from "../../utils";

const { ACROSS_USER_AGENT = "across-protocol" } = process.env;

// Only the address field is consumed; any other fields supplied in the
// response are permitted and ignored.
const RESPONSE_TYPE = array(type({ address: string() }));

export type AdapterOptions = {
  path: string;
  name?: string;
  timeout?: number;
  retries?: number;
  throwOnError?: boolean;
  logger?: winston.Logger;
};

// Reads a JSON array of { address, ... } objects from a remote HTTP(S) URL.
// nb. Modelled on the @across-protocol/sdk addressAggregator adapters and a
// candidate for upstreaming. No source URL is embedded here; it must be
// supplied by the caller (see Config.update()).
export class AddressList {
  readonly name: string;
  readonly path: string;
  readonly timeout: number;
  readonly retries: number;
  readonly throwOnError: boolean;
  readonly logger?: winston.Logger;

  constructor(opts: AdapterOptions) {
    this.name = opts.name ?? "http";
    this.path = opts.path;
    this.timeout = opts.timeout ?? 10_000;
    this.retries = opts.retries ?? 2;
    this.throwOnError = opts.throwOnError ?? true;
    this.logger = opts.logger;
  }

  async update(): Promise<string[]> {
    let response: unknown;
    try {
      response = await this.fetch();
    } catch (err) {
      return this.error(err);
    }

    if (!RESPONSE_TYPE.is(response)) {
      return this.error("Failed to validate response");
    }

    return response.map(({ address }) => address);
  }

  protected async fetch(): Promise<unknown> {
    const errs: string[] = [];
    let tries = 0;
    do {
      try {
        return await fetchWithTimeout(this.path, {}, { "User-Agent": ACROSS_USER_AGENT }, this.timeout);
      } catch (err) {
        errs.push(err instanceof Error ? err.message : "unknown error");
        if (++tries <= this.retries) {
          await new Promise((r) => setTimeout(r, Math.pow(1.5, tries) * 1000)); // simple backoff
        }
      }
    } while (tries <= this.retries);

    throw new Error(`${this.name} retrieval failure (${errs.join(", ")})`);
  }

  protected error(error: unknown): Promise<string[]> {
    if (this.throwOnError) {
      throw error;
    }

    const reason = error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";
    const { name, retries, timeout } = this;
    this.logger?.warn({
      at: `${name}::update`,
      message: `Failed to read addresses from ${name}.`,
      reason,
      retries,
      timeout,
    });
    return Promise.resolve([]);
  }
}

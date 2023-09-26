import assert from "assert";
import axios from "axios";

export type BaseHTTPAdapterArgs = {
  timeout?: number;
  retries?: number;
};

export class BaseHTTPAdapter {
  private _retries = 0;
  private _timeout = 0;

  get retries(): number {
    return this._retries;
  }

  set retries(retries: number) {
    assert(retries >= 0);
    this._retries = retries;
  }

  get timeout(): number {
    return this._timeout;
  }

  set timeout(timeout: number) {
    assert(timeout >= 0);
    this._timeout = timeout;
  }

  constructor(
    public readonly name: string,
    public readonly host: string,
    { timeout = 1000, retries = 1 }: BaseHTTPAdapterArgs
  ) {
    this.retries = retries;
    this.timeout = timeout; // ms
  }

  async post(path: string, urlArgs?: object): Promise<unknown> {
    const url = `${this.host}/${path ?? ""}`;
    const args = {
      timeout: this.timeout,
      params: urlArgs ?? {},
    };

    delete axios.defaults.headers.post['Accept-Encoding'];
    const errs: string[] = [];
    let tries = 0;
    do {
      try {
        return (await axios.post(url, urlArgs)).data;
      } catch (err) {
        console.log(`error: ${JSON.stringify(err)}.`);
        const errMsg = axios.isAxiosError(err) || err instanceof Error ? err.message : "unknown error";
        errs.push(errMsg);
        if (++tries <= this.retries) await this.sleep(Math.pow(1.5, tries) * 1000); // simple backoff
      }
    } while (tries <= this.retries);

    throw new Error(`${this.name} price lookup failure (${errs.join(", ")})`);
  }

  async query(path: string, urlArgs?: object): Promise<unknown> {
    const url = `${this.host}/${path ?? ""}`;
    const args = {
      timeout: this.timeout,
      params: urlArgs ?? {},
    };

    const errs: string[] = [];
    let tries = 0;
    do {
      try {
        return (await axios(url, args)).data;
      } catch (err) {
        const errMsg = axios.isAxiosError(err) || err instanceof Error ? err.message : "unknown error";
        errs.push(errMsg);
        if (++tries <= this.retries) await this.sleep(Math.pow(1.5, tries) * 1000); // simple backoff
      }
    } while (tries <= this.retries);

    throw new Error(`${this.name} price lookup failure (${errs.join(", ")})`);
  }

  protected async sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

import axios, { AxiosError } from "axios";
import { getAcrossIndexerHost } from "./";
import { winston, CHAIN_IDs } from "../utils";

export class AcrossIndexerApiClient {
  private readonly urlBase;
  private readonly apiResponseTimeout;

  constructor(readonly logger: winston.Logger, timeoutMs = 3000) {
    this.urlBase = `https://${getAcrossIndexerHost(CHAIN_IDs.MAINNET)}/api`;
    this.apiResponseTimeout = timeoutMs;
  }

  public async get<T>(urlEndpoint: string, params: Record<string, unknown>): Promise<T | undefined> {
    return this._get<T>(urlEndpoint, params);
  }

  private async _get<T>(endpoint: string, params: Record<string, unknown>): Promise<T | undefined> {
    try {
      const response = await axios.get<T>(`${this.urlBase}/${endpoint}`, {
        timeout: this.apiResponseTimeout,
        params,
      });

      if (!response?.data) {
        this.logger.warn({
          at: "AcrossIndexerApiClient",
          message: `Invalid response from ${this.urlBase}`,
          endpoint,
          params,
        });
        return;
      }
      return response.data;
    } catch (err) {
      this.logger.warn({
        at: "AcrossIndexerApiClient",
        message: `Failed to post to ${this.urlBase}`,
        endpoint,
        params,
        error: (err as AxiosError).message,
      });
      return;
    }
  }
}

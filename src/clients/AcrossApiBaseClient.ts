import axios, { AxiosError } from "axios";
import winston from "winston";

/**
 * Base client for Across HTTP APIs. Provides shared GET logic with timeout and error handling.
 * Subclasses set urlBase and logContext in the constructor.
 */
export abstract class AcrossApiBaseClient {
  protected readonly urlBase: string;
  protected readonly apiResponseTimeout: number;
  /** Used in log "at" field (e.g. "AcrossSwapApiClient"). */
  protected readonly logContext: string;

  constructor(readonly logger: winston.Logger, urlBase: string, logContext: string, timeoutMs = 3000) {
    this.urlBase = urlBase;
    this.logContext = logContext;
    this.apiResponseTimeout = timeoutMs;
  }

  /**
   * @notice Exposes a non-cached GET request to the API at the specified endpoint.
   */
  public async get<T>(urlEndpoint: string, params: Record<string, unknown>): Promise<T | undefined> {
    return this._get<T>(urlEndpoint, params);
  }

  protected async _get<T>(endpoint: string, params: Record<string, unknown>): Promise<T | undefined> {
    try {
      const response = await axios.get<T>(`${this.urlBase}/${endpoint}`, {
        timeout: this.apiResponseTimeout,
        params,
      });

      if (!response?.data) {
        this.logger.warn({
          at: this.logContext,
          message: `Invalid response from ${this.urlBase}`,
          endpoint,
          params,
        });
        return;
      }
      return response.data;
    } catch (err) {
      this.logger.warn({
        at: this.logContext,
        message: `Failed to get from ${this.urlBase}`,
        endpoint,
        params,
        error: (err as AxiosError).message,
      });
      return;
    }
  }
}

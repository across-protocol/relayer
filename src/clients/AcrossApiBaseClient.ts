import { fetchWithTimeout, postWithTimeout } from "../utils/SDKUtils";
import winston from "winston";

/**
 * Base client for Across HTTP APIs. Provides shared GET logic with timeout and error handling.
 * Subclasses set urlBase and logContext in the constructor.
 * Optional apiKey is sent as Authorization: Bearer <apiKey> when set.
 */
export abstract class BaseAcrossApiClient {
  protected readonly urlBase: string;
  protected readonly apiResponseTimeout: number;
  protected readonly logContext: string;
  protected readonly apiKey: string | undefined;

  constructor(
    readonly logger: winston.Logger,
    urlBase: string,
    logContext: string,
    timeoutMs = 3000,
    apiKey?: string
  ) {
    this.urlBase = urlBase;
    this.logContext = logContext;
    this.apiResponseTimeout = timeoutMs;
    this.apiKey = apiKey;
  }

  /**
   * @notice Exposes a non-cached GET request to the API at the specified endpoint.
   */
  public async get<T>(urlEndpoint: string, params: Record<string, unknown>): Promise<T | undefined> {
    return this._get<T>(urlEndpoint, params);
  }

  protected async _get<T>(endpoint: string, params: Record<string, unknown>): Promise<T | undefined> {
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const result = await fetchWithTimeout<T>(`${this.urlBase}/${endpoint}`, params, headers, this.apiResponseTimeout);

      if (!result) {
        this.logger.warn({
          at: this.logContext,
          message: `Invalid response from ${this.urlBase}`,
          endpoint,
          params,
        });
        return;
      }
      return result;
    } catch (err) {
      this.logger.warn({
        at: this.logContext,
        message: `Failed to get from ${this.urlBase}`,
        endpoint,
        params,
        error: (err as Error).message,
      });
      return;
    }
  }

  protected async _post<T>(endpoint: string, body: unknown): Promise<T | undefined> {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const result = await postWithTimeout<T>(
        `${this.urlBase}/${endpoint}`,
        body,
        {},
        headers,
        this.apiResponseTimeout
      );

      if (!result) {
        this.logger.warn({
          at: this.logContext,
          message: `Invalid response from ${this.urlBase}`,
          endpoint,
        });
        return;
      }
      return result;
    } catch (err) {
      this.logger.warn({
        at: this.logContext,
        message: `Failed to post to ${this.urlBase}`,
        endpoint,
        error: (err as Error).message,
      });
      return;
    }
  }

  /**
   * Like `_post`, but **rethrows** instead of collapsing failures to `undefined`. Callers that
   * must classify the failure (e.g. distinguish a terminal 4xx from a retryable transient error)
   * use this and inspect the thrown error — `postWithTimeout` throws a typed `HttpError` carrying
   * the HTTP `status` on non-2xx responses. Still logs at warn for observability parity with `_post`.
   */
  protected async _postOrThrow<T>(endpoint: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    try {
      return await postWithTimeout<T>(`${this.urlBase}/${endpoint}`, body, {}, headers, this.apiResponseTimeout);
    } catch (err) {
      this.logger.warn({
        at: this.logContext,
        message: `Failed to post to ${this.urlBase}`,
        endpoint,
        error: (err as Error).message,
      });
      throw err;
    }
  }
}

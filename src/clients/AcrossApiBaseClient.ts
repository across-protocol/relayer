import { fetchWithTimeout, postWithTimeout, HttpError } from "../utils/SDKUtils";
import winston from "winston";

/**
 * Non-2xx response from an Across API, carrying the structured error body the API returns:
 * `{ type, code, status, message, param, id }`. Extends the SDK's `HttpError` so callers that only
 * classify on the status (`isHttpError(err) && err.status === 422`) keep working unchanged; `code`
 * is the API's stable machine-readable discriminator (e.g. `AMOUNT_BELOW_MINIMUM`,
 * `GAS_EXCEEDS_REFUND`), which several statuses share.
 */
export class AcrossApiHttpError extends HttpError {
  constructor(
    status: number,
    message: string,
    readonly code?: string,
    readonly param?: string
  ) {
    super(status, message);
    this.name = "AcrossApiHttpError";
  }
}

/**
 * Builds an {@link AcrossApiHttpError} from a failed response body. Across APIs put the human
 * message on `message` and the discriminator on `code`; `error` is accepted as a fallback since
 * that is the key the SDK's fetch helpers look for. A non-JSON body degrades to the status line.
 */
function toAcrossApiHttpError(status: number, statusText: string, body: string): AcrossApiHttpError {
  let parsed: { code?: unknown; param?: unknown; message?: unknown; error?: unknown } | undefined;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Non-JSON error body (e.g. an upstream proxy's HTML); fall back to the status line below.
  }
  const asString = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined);
  return new AcrossApiHttpError(
    status,
    asString(parsed?.message) ?? asString(parsed?.error) ?? `HTTP ${status}: ${statusText}`,
    asString(parsed?.code),
    asString(parsed?.param)
  );
}

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

  /**
   * Like `_postOrThrow`, but preserves the API's error `code` by throwing an
   * {@link AcrossApiHttpError}. Callers that must distinguish *which* terminal condition a status
   * represents (e.g. `AMOUNT_BELOW_MINIMUM` vs any other 422) use this.
   *
   * Does its own `fetch` rather than delegating to `postWithTimeout`: that helper reads the error
   * body only for an `error` key, which Across API error responses never set (they serialize
   * `{ type, code, status, message, param, id }`), so it discards the code and collapses every 422
   * to "HTTP 422: Unprocessable Entity".
   */
  protected async _postOrThrowWithErrorCode<T>(endpoint: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    const url = `${this.urlBase}/${endpoint}`;
    try {
      const response = await fetch(url, {
        method: "POST",
        body: JSON.stringify(body),
        headers,
        ...(this.apiResponseTimeout > 0 && { signal: AbortSignal.timeout(this.apiResponseTimeout) }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw toAcrossApiHttpError(response.status, response.statusText, text);
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(
          `Expected JSON response from ${url} but received content-type: ${
            response.headers.get("content-type") ?? "unknown"
          } (body: ${text.slice(0, 256)})`
        );
      }
    } catch (err) {
      this.logger.warn({
        at: this.logContext,
        message: `Failed to post to ${this.urlBase}`,
        endpoint,
        error: (err as Error).message,
        ...(err instanceof AcrossApiHttpError && { status: err.status, code: err.code, param: err.param }),
      });
      throw err;
    }
  }
}

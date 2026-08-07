import { BinanceApi } from "../../src/utils";

type Handler = (payload?: unknown) => unknown;

/**
 * Builds a fake `BinanceApi` bundle from a flat map of endpoint handlers.
 *
 * Binance's connectors split the REST surface across `spot` and `wallet` and wrap every response in
 * `{ data(): Promise<T> }`. Tests supply a plain handler per endpoint returning the payload; the handler
 * is registered on both connectors (our endpoint names do not collide) and the envelope is added here,
 * so fakes stay flat and readable. Endpoints a test does not stub are absent, so unexpected calls throw.
 */
export function makeFakeBinanceApi(handlers: Record<string, Handler>): BinanceApi {
  const restAPI = Object.fromEntries(
    Object.entries(handlers).map(([method, handler]) => [
      method,
      async (payload?: unknown) => ({ data: async () => handler(payload) }),
    ])
  );
  return { spot: { restAPI }, wallet: { restAPI } } as unknown as BinanceApi;
}

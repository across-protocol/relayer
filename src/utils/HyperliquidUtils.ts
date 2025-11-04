import { Signer, isSignerWallet, assert, delay } from "./";
import * as hl from "@nktkas/hyperliquid";

export function getDefaultHlTransport(extraOptions: ConstructorParameters<typeof hl.HttpTransport> = []) {
  return new hl.HttpTransport(...extraOptions);
}

export function getHlExchangeClient(
  signer: Signer,
  transport: hl.HttpTransport | hl.WebSocketTransport = getDefaultHlTransport()
) {
  assert(
    isSignerWallet(signer),
    "HyperliquidUtils#getHlExchangeClient: Cannot define an exchange client without a wallet."
  );
  return new hl.ExchangeClient({ wallet: signer, transport });
}

export function getHlInfoClient(transport: hl.HttpTransport | hl.WebSocketTransport = getDefaultHlTransport()) {
  return new hl.InfoClient({ transport });
}

export async function getL2Book(
  infoClient: hl.InfoClient,
  params: hl.L2BookParameters,
  nRetries = 0,
  maxRetries = 3
): Promise<hl.L2BookResponse> {
  return await _callWithRetry(infoClient.l2Book.bind(infoClient), [params], nRetries, maxRetries);
}

export async function getOpenOrders(
  infoClient: hl.InfoClient,
  params: hl.OpenOrdersParameters,
  nRetries = 0,
  maxRetries = 3
): Promise<hl.OpenOrdersResponse> {
  return _callWithRetry(infoClient.openOrders.bind(infoClient), [params], nRetries, maxRetries);
}

export async function getHistoricalOrders(
  infoClient: hl.InfoClient,
  params: hl.HistoricalOrdersParameters,
  nRetries = 0,
  maxRetries = 3
): Promise<hl.HistoricalOrdersResponse> {
  return _callWithRetry(infoClient.historicalOrders.bind(infoClient), [params], nRetries, maxRetries);
}

export async function getOrderStatus(
  infoClient: hl.InfoClient,
  params: hl.OrderStatusParameters,
  nRetries = 0,
  maxRetries = 3
): Promise<hl.OrderStatusResponse> {
  return _callWithRetry(infoClient.orderStatus.bind(infoClient), [params], nRetries, maxRetries);
}

async function _callWithRetry<T, A extends any[]>(
  apiCall: (...args: A) => Promise<T>,
  args: A,
  nRetries: number,
  maxRetries: number
): Promise<T> {
  try {
    return await apiCall(...args);
  } catch (e) {
    if (nRetries > maxRetries) {
      throw new Error(`Max retries exceeded when querying the hyperliquid API: ${e}`);
    }
    const delaySeconds = 2 ** nRetries + Math.random();
    await delay(delaySeconds);
    // @todo Once we have a better idea on the types of errors we can suppress/retry on, then choose appropriate action based on the error thrown.
    return await _callWithRetry(apiCall, args, ++nRetries, maxRetries);
  }
}

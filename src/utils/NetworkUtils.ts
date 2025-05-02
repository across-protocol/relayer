import Binance from "binance-api-node";
import { utils as sdkUtils } from "@across-protocol/sdk";
import { isDefined, assert } from "./";

export const { getNetworkName, getNativeTokenSymbol } = sdkUtils;

/**
 * Returns the origin of a URL.
 * @param url A URL.
 * @returns The origin of the URL, or "UNKNOWN" if the URL is invalid.
 */
export function getOriginFromURL(url: string): string {
  try {
    return new URL(url).origin;
  } catch (e) {
    return "UNKNOWN";
  }
}

/**
 * Returns an API client to interface with Binance
 * @param url The base HTTP url to use to connect to Binance.
 * @returns A Binance client from `binance-api-node`.
 */
export function getBinanceApiClient(url = "https://api.binance.com") {
  const apiKey = process.env["BINANCE_API_KEY"];
  const secretKey = process.env["BINANCE_HMAC_KEY"];
  assert(isDefined(apiKey) && isDefined(secretKey), "Binance client cannot be constructed due to missing keys.");
  return Binance({
    apiKey,
    apiSecret: secretKey,
    httpBase: url,
  });
}

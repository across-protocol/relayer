import Binance, { HttpMethod, type Binance as BinanceApi } from "binance-api-node";
import minimist from "minimist";
import { getGckmsConfig, retrieveGckmsKeys, isDefined, assert } from "./";

// Store global promises on Gckms key retrievel actions so that we don't retrieve the same key multiple times.
let binanceSecretKeyPromise = undefined;

type WithdrawalQuota = {
  wdQuota: number;
  usedWdQuota: number;
};

/**
 * Returns an API client to interface with Binance
 * @param url The base HTTP url to use to connect to Binance.
 * @returns A Binance client from `binance-api-node`.
 */
export async function getBinanceApiClient(url = "https://api.binance.com") {
  const apiKey = process.env["BINANCE_API_KEY"];
  const secretKey = (await getBinanceSecretKey()) ?? process.env["BINANCE_HMAC_KEY"];
  assert(isDefined(apiKey) && isDefined(secretKey), "Binance client cannot be constructed due to missing keys.");
  return Binance({
    apiKey,
    apiSecret: secretKey,
    httpBase: url,
  });
}

/**
 * Retrieves a Binance API secret key from GCKMS if the key is stored in GCKMS.
 * @returns A base64 encoded secret key, or undefined if the key is not present in GCKMS.
 */
async function getBinanceSecretKey(): Promise<string | undefined> {
  binanceSecretKeyPromise ??= retrieveBinanceSecretKeyFromCLIArgs();
  return binanceSecretKeyPromise;
}

/**
 * Retrieves a Binance HMAC secret key based on CLI args.
 * @returns A Binance API secret key if present in the arguments, or otherwise `undefined`.
 */
async function retrieveBinanceSecretKeyFromCLIArgs(): Promise<string | undefined> {
  const opts = {
    string: ["binanceSecretKey"],
  };
  const args = minimist(process.argv.slice(2), opts);
  if (!isDefined(args.binanceSecretKey)) {
    return undefined;
  }
  const binanceKeys = await retrieveGckmsKeys(getGckmsConfig([args.binanceSecretKey]));
  if (binanceKeys.length === 0) {
    return undefined;
  }
  return binanceKeys[0].slice(2);
}

/**
 * Retrieves the input client account's withdrawal quota.
 * @dev This is in a utility function since the Binance API does not natively support calling this endpoint.
 * @returns an object with two fields: `wdQuota` and `usedWdQuota`, corresponding to the total amount
 * available to rebalance per day and the amount already used.
 */
export async function getBinanceWithdrawalLimits(binanceApi: BinanceApi): Promise<WithdrawalQuota> {
  const unparsedQuota = await binanceApi.privateRequest("GET" as HttpMethod, "/sapi/v1/capital/withdraw/quota", {});
  return {
    wdQuota: unparsedQuota["wdQuota"],
    usedWdQuota: unparsedQuota["usedWdQuota"],
  };
}

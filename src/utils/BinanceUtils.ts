import Binance, { HttpMethod, type Binance as BinanceApi } from "binance-api-node";
import minimist from "minimist";
import { getGckmsConfig, retrieveGckmsKeys, isDefined, assert, ethers, mapAsync } from "./";

// Store global promises on Gckms key retrieval actions so that we don't retrieve the same key multiple times.
let binanceSecretKeyPromise = undefined;

type WithdrawalQuota = {
  wdQuota: number;
  usedWdQuota: number;
};

// Alias for Binance network symbols.
export enum DepositNetwork {
  Ethereum = "ETH",
  BSC = "BSC",
}

// A Coin contains balance data and network information (such as withdrawal limits, extra information about the network, etc.) for a specific
// token.
type Coin = {
  symbol: string;
  balance: string;
  networkList: Network[];
};

// Network represents basic information corresponding to a Binance supported deposit/withdrawal network. It is always associated with a coin.
type Network = {
  name: string;
  coin: string;
  withdrawMin: string;
  withdrawMax: string;
  contractAddress: string;
};

// A BinanceInteraction is either a deposit or withdrawal into/from a Binance hot wallet.
type BinanceInteraction = {
  // The amount of `coin` transferred in this interaction.
  amount: number;
  // The external (non binance-wallet) EOA involved with this interaction.
  externalAddress: string;
  // The coin used in this interaction (i.e. the token symbol).
  coin: string;
  // The network on which this interaction took place.
  network: string;
  // The status of the deposit/withdrawal.
  status?: number;
};

// ParsedAccountCoins represents a simplified return type of the Binance `accountCoins` endpoint.
type ParsedAccountCoins = Coin[];

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

/**
 * Gets all binance deposits for the Binance account starting from `startTime`-present.
 * @returns An array of parsed binance deposits.
 */
export async function getBinanceDeposits(
  binanceApi: BinanceApi,
  l1Provider: ethers.providers.Provider,
  l2Provider: ethers.providers.Provider,
  startTime: number
): Promise<BinanceInteraction[]> {
  const _depositHistory = await binanceApi.depositHistory({ startTime });
  const depositHistory = Object.values(_depositHistory);

  return mapAsync(depositHistory, async (deposit) => {
    const provider = deposit.network === DepositNetwork.Ethereum ? l1Provider : l2Provider;
    const depositTxnReceipt = await provider.getTransactionReceipt(deposit.txId);
    return {
      amount: Number(deposit.amount),
      externalAddress: depositTxnReceipt.from,
      coin: deposit.coin,
      network: deposit.network,
      status: deposit.status,
    };
  });
}

/**
 * Gets all Binance withdrawals of a specific coin starting from `startTime`-present.
 * @returns An array of parsed binance withdrawals.
 */
export async function getBinanceWithdrawals(
  binanceApi: BinanceApi,
  coin: string,
  startTime: number
): Promise<BinanceInteraction[]> {
  const withdrawals = await binanceApi.withdrawHistory({ coin, startTime });

  return Object.values(withdrawals).map((withdrawal) => {
    return {
      amount: Number(withdrawal.amount),
      externalAddress: withdrawal.address,
      coin,
      network: withdrawal.network,
      status: withdrawal.status,
    };
  });
}

/**
 * The call to accountCoins returns an opaque `unknown` object with extraneous information. This function
 * parses the unknown into a readable object to be used by the finalizers.
 * @returns A typed `AccountCoins` response.
 */
export async function getAccountCoins(binanceApi: BinanceApi): Promise<ParsedAccountCoins> {
  const coins = Object.values(await binanceApi["accountCoins"]());
  return coins.map((coin) => {
    const networkList = coin["networkList"]?.map((network) => {
      return {
        name: network["network"],
        coin: network["coin"],
        withdrawMin: network["withdrawMin"],
        withdrawMax: network["withdrawMax"],
        contractAddress: network["contractAddress"],
      } as Network;
    });
    return {
      symbol: coin["coin"],
      balance: coin["free"],
      networkList,
    } as Coin;
  });
}

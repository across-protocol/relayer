import Binance, {
  HttpMethod,
  DepositHistoryResponse,
  WithdrawHistoryResponse,
  type Binance as BinanceApi,
} from "binance-api-node";
import minimist from "minimist";
import { getGckmsConfig, retrieveGckmsKeys, isDefined, assert, delay, CHAIN_IDs } from "./";

// Store global promises on Gckms key retrieval actions so that we don't retrieve the same key multiple times.
let binanceSecretKeyPromise = undefined;

// Known transient errors the Binance API returns. If a response is one of these errors, then the API call should be retried.
const KNOWN_BINANCE_ERROR_REASONS = [
  "Timestamp for this request is outside of the recvWindow",
  "Too many requests; current request has limited",
  "TypeError: fetch failed",
];

type WithdrawalQuota = {
  wdQuota: number;
  usedWdQuota: number;
};

// Alias for Binance network symbols.
export const BINANCE_NETWORKS: { [chainId: number]: string } = {
  [CHAIN_IDs.ARBITRUM]: "ARBITRUM",
  [CHAIN_IDs.BASE]: "BASE",
  [CHAIN_IDs.BSC]: "BSC",
  [CHAIN_IDs.MAINNET]: "ETH",
  [CHAIN_IDs.OPTIMISM]: "OPTIMISM",
  [CHAIN_IDs.ZK_SYNC]: "ZKSYNCERA",
};

// A Coin contains balance data and network information (such as withdrawal limits, extra information about the network, etc.) for a specific
// token.
export type Coin = {
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
  withdrawFee: string;
};

// A BinanceDeposit is either a simplified element of the return type of the Binance API's `depositHistory`.
type BinanceDeposit = {
  // The amount of `coin` transferred in this interaction.
  amount: number;
  // The coin used in this interaction (i.e. the token symbol).
  coin: string;
  // The network on which this interaction took place.
  network: string;
  // The transaction hash of the deposit.
  txId: string;
  // The status of the deposit/withdrawal.
  status?: number;
};

// A BinanceWithdrawal is a simplified element of the return type of the Binance API's `withdrawHistory`.
export type BinanceWithdrawal = BinanceDeposit & {
  // The recipient of `coin` on the destination network.
  recipient: string;
  // The unique withdrawal ID.
  id: string;
  // The transaction fee for the withdrawal.
  transactionFee: number;
  // The timestamp of the withdrawal.
  applyTime: string;
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
  startTime: number,
  nRetries = 0,
  maxRetries = 3
): Promise<BinanceDeposit[]> {
  let depositHistory: DepositHistoryResponse;
  try {
    depositHistory = await binanceApi.depositHistory({ startTime });
  } catch (_err) {
    const err = _err.toString();
    if (KNOWN_BINANCE_ERROR_REASONS.some((errorReason) => err.includes(errorReason)) && nRetries < maxRetries) {
      const delaySeconds = 2 ** nRetries + Math.random();
      await delay(delaySeconds);
      return getBinanceDeposits(binanceApi, startTime, ++nRetries, maxRetries);
    }
    throw err;
  }
  return Object.values(depositHistory).map((deposit) => {
    return {
      amount: Number(deposit.amount),
      coin: deposit.coin,
      network: deposit.network,
      txId: deposit.txId,
      status: deposit.status,
    } satisfies BinanceDeposit;
  });
}

/**
 * Gets all Binance withdrawals of a specific coin starting from `startTime`-present.
 * @returns An array of parsed binance withdrawals.
 */
export async function getBinanceWithdrawals(
  binanceApi: BinanceApi,
  coin: string,
  startTime: number,
  nRetries = 0,
  maxRetries = 3
): Promise<BinanceWithdrawal[]> {
  let withdrawHistory: WithdrawHistoryResponse;
  try {
    withdrawHistory = await binanceApi.withdrawHistory({ coin, startTime });
  } catch (_err) {
    const err = _err.toString();
    if (KNOWN_BINANCE_ERROR_REASONS.some((errorReason) => err.includes(errorReason)) && nRetries < maxRetries) {
      const delaySeconds = 2 ** nRetries + Math.random();
      await delay(delaySeconds);
      return getBinanceWithdrawals(binanceApi, coin, startTime, ++nRetries, maxRetries);
    }
    throw err;
  }
  return Object.values(withdrawHistory).map((withdrawal) => {
    return {
      amount: Number(withdrawal.amount),
      transactionFee: Number(withdrawal.transactionFee),
      recipient: withdrawal.address,
      coin,
      id: withdrawal.id,
      txId: withdrawal.txId,
      network: withdrawal.network,
      status: withdrawal.status,
      applyTime: withdrawal.applyTime,
    } satisfies BinanceWithdrawal;
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
        withdrawFee: network["withdrawFee"],
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

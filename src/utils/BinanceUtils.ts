import Binance, {
  HttpMethod,
  DepositHistoryResponse,
  WithdrawHistoryResponse,
  type Binance as BinanceApi,
} from "binance-api-node";
import minimist from "minimist";
import { getGckmsConfig, retrieveGckmsKeys, isDefined, assert, delay, CHAIN_IDs, getRedisCache, truncate } from "./";

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
export type BinanceDeposit = {
  // The amount of `coin` transferred in this interaction.
  amount: number;
  // The coin used in this interaction (i.e. the token symbol).
  coin: string;
  // The network on which this interaction took place.
  network: string;
  // The transaction hash of the deposit.
  txId: string;
  // The timestamp that Binance assigns the deposit.
  insertTime: number;
  // The status of the deposit/withdrawal.
  status?: number;
};

// A BinanceWithdrawal is a simplified element of the return type of the Binance API's `withdrawHistory`.
export type BinanceWithdrawal = Omit<BinanceDeposit, "insertTime"> & {
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

export enum BinanceTransactionType {
  BRIDGE, // A deposit into Binance from one network designed to be withdrawn to another network.
  SWAP, // A deposit into Binance from one network designed to be swapped and then withdrawn to another network.
  UNKNOWN,
}

const BINANCE_TRANSACTION_TYPE_PREFIX = "binance-transaction-type";
export function getBinanceTransactionTypeKey(chainId: number, uniqueIdentifier: string): string {
  const binanceNetworkName = BINANCE_NETWORKS[chainId].toLowerCase();
  return getBinanceTransactionTypeKeyFromNetworkName(binanceNetworkName, uniqueIdentifier);
}

function getBinanceTransactionTypeKeyFromNetworkName(networkName: string, uniqueIdentifier: string): string {
  return `${BINANCE_TRANSACTION_TYPE_PREFIX}:${networkName.toLowerCase()}:${uniqueIdentifier}`;
}

/**
 * @notice Tag a deposit to the Redis cache with a custom status so that all functions interacting with the
 * same Binance account can distinguish between "types" of deposits.
 * @param depositChain The chain ID of the network that the deposit was made from.
 * @param transactionHash Hash of the transaction that initiated the deposit. We know this at the time of deposit so its convenient
 * to use as part of the unique identifier.
 * @param type The type of transaction to save to the Redis cache.
 */
export async function setBinanceDepositType(
  depositChain: number,
  transactionHash: string,
  type: BinanceTransactionType,
  ttl?: number
): Promise<void> {
  const redisCache = await getRedisCache();
  const redisKey = getBinanceTransactionTypeKey(depositChain, transactionHash);
  await redisCache.set(redisKey, type, ttl);
}

/**
 * @notice Tag a withdrawal to the Redis cache with a custom status so that all functions interacting with the
 * same Binance account can distinguish between "types" of withdrawals.
 * @param withdrawalChain The chain ID of the network that the withdrawal was made from.
 * @param withdrawalId The unique withdrawal ID returned to us by the Binance API at the time of initiating the withdrawal.
 * @param type The type of transaction to save to the Redis cache.
 */
export async function setBinanceWithdrawalType(
  withdrawalChain: number,
  withdrawalId: string,
  type: BinanceTransactionType
): Promise<void> {
  const redisCache = await getRedisCache();
  const redisKey = getBinanceTransactionTypeKey(withdrawalChain, withdrawalId);
  await redisCache.set(redisKey, type);
}

/**
 * @notice Return the type of a deposit based on its network name and unique identifier.
 * @param depositDetails API response object returned by getBinanceDeposits(). The unique identifier should be
 * the transaction hash of the deposit transaction on the deposit network.
 * @returns The type of the deposit.
 */
export async function getBinanceDepositType(
  depositDetails: Pick<BinanceDeposit, "network" | "txId">
): Promise<BinanceTransactionType> {
  const redisCache = await getRedisCache();
  const redisKey = getBinanceTransactionTypeKeyFromNetworkName(depositDetails.network, depositDetails.txId);
  const depositType = await redisCache.get<string>(redisKey);
  if (isDefined(depositType)) {
    return Number(depositType);
  } else {
    return BinanceTransactionType.UNKNOWN;
  }
}

/**
 * @notice Return the type of a withdrawal based on its network name and unique identifier.
 * @param withdrawalDetails API response object returned by getBinanceWithdrawals(). The unique identifier should be
 * the withdrawal ID returned to us by the Binance API at the time of initiating the withdrawal.
 * @returns The type of the withdrawal.
 */
export async function getBinanceWithdrawalType(
  withdrawalDetails: Pick<BinanceWithdrawal, "network" | "id">
): Promise<BinanceTransactionType> {
  const redisCache = await getRedisCache();
  const redisKey = getBinanceTransactionTypeKeyFromNetworkName(withdrawalDetails.network, withdrawalDetails.id);
  const withdrawalType = await redisCache.get<string>(redisKey);
  if (isDefined(withdrawalType)) {
    return Number(withdrawalType);
  } else {
    return BinanceTransactionType.UNKNOWN;
  }
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
      insertTime: deposit.insertTime,
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

/**
 * Computes outstanding deposits for a given deposit network given a list of executed withdrawals that
 * match against non-outstanding or already-finalized deposits.
 * @param deposits All deposits for the same coin across all networks for the monitored address.
 * @param withdrawals All L1 withdrawals for the same coin for the monitored address.
 * @param depositNetwork The network to compute unmatched volume for.
 * @returns The list of unmatched deposits on `depositNetwork` along with their amount outstanding.
 */
export function getOutstandingBinanceDeposits(
  deposits: BinanceDeposit[],
  withdrawals: BinanceWithdrawal[],
  depositNetwork: string
): BinanceDeposit[] {
  assert(
    withdrawals.every((withdrawal) => withdrawal.network === BINANCE_NETWORKS[CHAIN_IDs.MAINNET]),
    "Withdrawals must be for the Mainnet network"
  );
  if (deposits.length === 0) {
    return [];
  }
  assert(
    deposits.every((deposit) => deposit.coin === deposits[0].coin),
    "Deposits must be for the same coin"
  );
  // Determining which deposits are outstanding is tricky for two reasons:
  // - Binance withdrawals on Ethereum can batch together deposited amounts from different L2s.
  // - It is not possible to determine which deposit is getting "finalized" by any withdrawal on Etheruem because
  //   there is no metadata associated with the withdrawal that indicates the L2 it originated from.
  // - Binance withdrawals can be greater than or less than the deposited amount for individual deposits.

  // First, find the net outstanding deposited amount.
  // @dev amount + txnFee can often exceed deposited amount due to existing dust on the Binance account
  // that also gets included in the batch withdrawal.
  const totalWithdrawalAmount = withdrawals.reduce((acc, w) => acc + Number(w.amount) + Number(w.transactionFee), 0);
  const totalDepositedAmount = deposits.reduce((acc, d) => acc + Number(d.amount), 0);
  let remainingOutstanding = totalDepositedAmount - totalWithdrawalAmount;
  if (remainingOutstanding <= 0) {
    return [];
  }

  // There is outstanding deposited amount, so iterate through deposits from newest to oldest
  // (newest deposits are most likely to be the ones not yet finalized) until we've accounted for
  // all outstanding volume.
  const sortedDepositsNewestFirst = deposits.slice().sort((a, b) => b.insertTime - a.insertTime);
  const outstandingDeposits: BinanceDeposit[] = [];
  for (const deposit of sortedDepositsNewestFirst) {
    if (remainingOutstanding <= 0) {
      break;
    }

    if (deposit.amount <= remainingOutstanding) {
      // Entire deposit is outstanding.
      outstandingDeposits.push({ ...deposit });
      remainingOutstanding -= deposit.amount;
    } else {
      // Only part of this deposit is outstanding. The rest was covered by withdrawals.
      // 8 decimal places is the precision of the Binance API and we truncate for simplicity sake and avoiding BN to float conversion issues.
      outstandingDeposits.push({ ...deposit, amount: truncate(remainingOutstanding, 8) });
      remainingOutstanding = 0;
    }
  }

  // Filter for the deposits on the specific network and return them.
  return outstandingDeposits.filter((deposit) => deposit.network === depositNetwork);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ethers } from "ethers";
import lodash from "lodash";
import winston from "winston";
import { isDefined, isPromiseFulfilled, isPromiseRejected } from "./TypeGuards";
import createQueue, { QueueObject } from "async/queue";
import { getRedis, RedisClient, setRedisKey } from "./RedisUtils";
import {
  CHAIN_CACHE_FOLLOW_DISTANCE,
  PROVIDER_CACHE_TTL,
  PROVIDER_CACHE_TTL_MODIFIER as ttl_modifier,
  BLOCK_NUMBER_TTL,
  DEFAULT_NO_TTL_DISTANCE,
} from "../common";
import { delay, getOriginFromURL, Logger } from "./";
import { compareArrayResultsWithIgnoredKeys, compareResultsAndFilterIgnoredKeys } from "./ObjectUtils";
import { MAINNET_CHAIN_IDs } from "@across-protocol/constants";

const logger = Logger;

// The async/queue library has a task-based interface for building a concurrent queue.
// This is the type we pass to define a request "task".
interface RateLimitTask {
  // These are the arguments to be passed to super.send().
  sendArgs: [string, Array<unknown>];

  // These are the promise callbacks that will cause the initial send call made by the user to either return a result
  // or fail.
  resolve: (result: any) => void;
  reject: (err: any) => void;
}

// StaticJsonRpcProvider is used in place of JsonRpcProvider to avoid redundant eth_chainId queries prior to each
// request. This is safe to use when the back-end provider is guaranteed not to change.
// See https://docs.ethers.io/v5/api/providers/jsonrpc-provider/#StaticJsonRpcProvider

// This provider is a very small addition to the StaticJsonRpcProvider that ensures that no more than `maxConcurrency`
// requests are ever in flight. It uses the async/queue library to manage this.
class RateLimitedProvider extends ethers.providers.StaticJsonRpcProvider {
  // The queue object that manages the tasks.
  private queue: QueueObject;

  // Takes the same arguments as the JsonRpcProvider, but it has an additional maxConcurrency value at the beginning
  // of the list.
  constructor(
    maxConcurrency: number,
    readonly pctRpcCallsLogged: number,
    ...cacheConstructorParams: ConstructorParameters<typeof ethers.providers.StaticJsonRpcProvider>
  ) {
    super(...cacheConstructorParams);

    // This sets up the queue. Each task is executed by calling the superclass's send method, which fires off the
    // request. This queue sends out requests concurrently, but stops once the concurrency limit is reached. The
    // maxConcurrency is configured here.
    this.queue = createQueue(async ({ sendArgs, resolve, reject }: RateLimitTask) => {
      await this.wrapSendWithLog(...sendArgs)
        .then(resolve)
        .catch(reject);
    }, maxConcurrency);
  }

  async wrapSendWithLog(method: string, params: Array<any>) {
    if (this.pctRpcCallsLogged <= 0 || Math.random() > this.pctRpcCallsLogged / 100) {
      // Non sample path: no logging or timing, just issue the request.
      return super.send(method, params);
    } else {
      const loggerArgs = {
        at: "ProviderUtils",
        message: "Provider response sample",
        provider: getOriginFromURL(this.connection.url),
        method,
        params,
        chainId: this.network.chainId,
      };

      // In this path we log an rpc response sample.
      // Note: use performance.now() to ensure a purely monotonic clock.
      const startTime = performance.now();
      try {
        const result = await super.send(method, params);
        const elapsedTimeS = (performance.now() - startTime) / 1000;
        logger.debug({
          ...loggerArgs,
          success: true,
          timeElapsed: elapsedTimeS,
        });
        return result;
      } catch (error) {
        // Log errors as well.
        // For now, to keep logs light, don't log the error itself, just propogate and let it be handled higher up.
        const elapsedTimeS = (performance.now() - startTime) / 1000;
        logger.debug({
          ...loggerArgs,
          success: false,
          timeElapsed: elapsedTimeS,
        });
        throw error;
      }
    }
  }

  override async send(method: string, params: Array<any>): Promise<any> {
    // This simply creates a promise and adds the arguments and resolve and reject handlers to the task.
    return new Promise<any>((resolve, reject) => {
      const task: RateLimitTask = {
        sendArgs: [method, params],
        resolve,
        reject,
      };
      this.queue.push(task);
    });
  }
}

const defaultTimeout = 60 * 1000;

function formatProviderError(provider: ethers.providers.StaticJsonRpcProvider, rawErrorText: string) {
  return `Provider ${provider.connection.url} failed with error: ${rawErrorText}`;
}

function createSendErrorWithMessage(message: string, sendError: any) {
  const error = new Error(message);
  return { ...sendError, ...error };
}

function compareRpcResults(method: string, rpcResultA: any, rpcResultB: any): boolean {
  if (method === "eth_getBlockByNumber") {
    // We've seen RPC's disagree on the miner field, for example when Polygon nodes updated software that
    // led alchemy and quicknode to disagree on the miner field's value.
    return compareResultsAndFilterIgnoredKeys(
      [
        "miner", // polygon (sometimes)
        "l1BatchNumber", // zkSync
        "l1BatchTimestamp", // zkSync
        "size", // Alchemy/Arbitrum (temporary)
        "totalDifficulty", // Quicknode/Alchemy (sometimes)
      ],
      rpcResultA,
      rpcResultB
    );
  } else if (method === "eth_getLogs") {
    // We've seen some RPC's like QuickNode add in transactionLogIndex which isn't in the
    // JSON RPC spec: https://ethereum.org/en/developers/docs/apis/json-rpc/#eth_getfilterchanges
    // Additional reference: https://github.com/ethers-io/ethers.js/issues/1721
    // 2023-08-31 Added blockHash because of upstream zkSync provider disagreements. Consider removing later.
    // 2024-05-07 Added l1BatchNumber and logType due to Alchemy. Consider removing later.
    return compareArrayResultsWithIgnoredKeys(
      ["transactionLogIndex", "l1BatchNumber", "logType"],
      rpcResultA,
      rpcResultB
    );
  } else {
    return lodash.isEqual(rpcResultA, rpcResultB);
  }
}

enum CacheType {
  NONE, // Do not cache
  WITH_TTL, // Cache with TTL
  NO_TTL, // Cache with infinite TTL
}

class CacheProvider extends RateLimitedProvider {
  public readonly getBlockByNumberPrefix: string;
  public readonly getLogsCachePrefix: string;
  public readonly callCachePrefix: string;
  public readonly baseTTL: number;

  constructor(
    providerCacheNamespace: string,
    readonly redisClient?: RedisClient,
    // Note: if not provided, this is set to POSITIVE_INFINITY, meaning no cache entries are set with the standard TTL.
    readonly standardTtlBlockDistance = Number.POSITIVE_INFINITY,
    // Note: if not provided, this is set to POSITIVE_INFINITY, meaning no cache entries are set with no TTL.
    readonly noTtlBlockDistance = Number.POSITIVE_INFINITY,
    ...jsonRpcConstructorParams: ConstructorParameters<typeof RateLimitedProvider>
  ) {
    super(...jsonRpcConstructorParams);

    const { chainId } = this.network;

    // Pre-compute as much of the redis key as possible.
    const cachePrefix = `${providerCacheNamespace},${new URL(this.connection.url).hostname},${chainId}`;
    this.getBlockByNumberPrefix = `${cachePrefix}:getBlockByNumber,`;
    this.getLogsCachePrefix = `${cachePrefix}:eth_getLogs,`;
    this.callCachePrefix = `${cachePrefix}:eth_call,`;

    const _ttlVar = process.env.PROVIDER_CACHE_TTL ?? PROVIDER_CACHE_TTL;
    const _ttl = Number(_ttlVar);
    if (isNaN(_ttl) || _ttl <= 0) {
      throw new Error(`PROVIDER_CACHE_TTL (${_ttlVar}) must be numeric and > 0`);
    }
    this.baseTTL = _ttl;
  }
  override async send(method: string, params: Array<any>): Promise<any> {
    const cacheType = this.redisClient ? await this.cacheType(method, params) : CacheType.NONE;

    if (cacheType !== CacheType.NONE) {
      const redisKey = this.buildRedisKey(method, params);

      // Attempt to pull the result from the cache.
      const redisResult = await this.redisClient.get(redisKey);

      // If cache has the result, parse the json and return it.
      if (redisResult) {
        return JSON.parse(redisResult);
      }

      // Cache does not have the result. Query it directly and cache.
      const result = await super.send(method, params);

      // Note: use swtich to ensure all enum cases are handled.
      switch (cacheType) {
        case CacheType.WITH_TTL:
          {
            // Apply a random margin to spread expiry over a larger time window.
            const ttl = this.baseTTL + Math.ceil(lodash.random(-ttl_modifier, ttl_modifier, true) * this.baseTTL);
            await setRedisKey(redisKey, JSON.stringify(result), this.redisClient, ttl);
          }
          break;
        case CacheType.NO_TTL:
          await setRedisKey(redisKey, JSON.stringify(result), this.redisClient, Number.POSITIVE_INFINITY);
          break;
        default:
          throw new Error(`Unexpected Cache type: ${cacheType}`);
      }

      // Return the cached result.
      return result;
    }

    return await super.send(method, params);
  }

  private buildRedisKey(method: string, params: Array<any>) {
    // Only handles eth_getLogs and eth_call right now.
    switch (method) {
      case "eth_getBlockByNumber":
        return this.getBlockByNumberPrefix + JSON.stringify(params);
      case "eth_getLogs":
        return this.getLogsCachePrefix + JSON.stringify(params);
      case "eth_call":
        return this.callCachePrefix + JSON.stringify(params);
      default:
        throw new Error(`CacheProvider::buildRedisKey: invalid JSON-RPC method ${method}`);
    }
  }

  private async cacheType(method: string, params: Array<any>): Promise<CacheType> {
    // Today, we only cache eth_getLogs and eth_call.
    if (method === "eth_getLogs") {
      const [{ fromBlock, toBlock }] = params;

      // Handle odd cases where the ordering is flipped, etc.
      // toBlock/fromBlock is in hex, so it must be parsed before being compared to the first unsafe block.
      const fromBlockNumber = parseInt(fromBlock, 16);
      const toBlockNumber = parseInt(toBlock, 16);

      // Handle cases where the input block numbers are not hex values ("latest", "pending", etc).
      // This would result in the result of the above being NaN.
      if (Number.isNaN(fromBlockNumber) || Number.isNaN(toBlockNumber)) {
        return CacheType.NONE;
      }

      if (toBlockNumber < fromBlockNumber) {
        throw new Error("CacheProvider::shouldCache toBlock cannot be smaller than fromBlock.");
      }

      return this.cacheTypeForBlock(toBlock);
    } else if ("eth_call" === method || "eth_getBlockByNumber" === method) {
      // Pull out the block tag from params. Its position in params is dependent on the method.
      // We are only interested in numeric block tags, which would be hex-encoded strings.
      const idx = method === "eth_getBlockByNumber" ? 0 : 1;
      const blockNumber = parseInt(params[idx], 16);

      // If the block number isn't present or is a text string, this will be NaN and we return false.
      if (Number.isNaN(blockNumber)) {
        return CacheType.NONE;
      }

      // If the block is old enough to cache, cache the call.
      return this.cacheTypeForBlock(blockNumber);
    } else {
      return CacheType.NONE;
    }
  }

  private async cacheTypeForBlock(blockNumber: number): Promise<CacheType> {
    // Note: this method is an internal method provided by the BaseProvider. It allows the caller to specify a maxAge of
    // the block that is allowed. This means if a block has been retrieved within the last n seconds, no provider
    // query will be made.
    const currentBlockNumber = await super._getInternalBlockNumber(BLOCK_NUMBER_TTL * 1000);

    // Determine the distance that the block is from HEAD.
    const headDistance = currentBlockNumber - blockNumber;

    // If the distance from head is large enough, set with no TTL.
    if (headDistance > this.noTtlBlockDistance) {
      return CacheType.NO_TTL;
    }

    // If the distance is <= noTtlBlockDistance, but > standardTtlBlockDistance, use standard TTL.
    if (headDistance > this.standardTtlBlockDistance) {
      return CacheType.WITH_TTL;
    }

    // Too close to HEAD, no cache.
    return CacheType.NONE;
  }
}

export class RetryProvider extends ethers.providers.StaticJsonRpcProvider {
  readonly providers: ethers.providers.StaticJsonRpcProvider[];
  constructor(
    params: ConstructorParameters<typeof ethers.providers.StaticJsonRpcProvider>[],
    chainId: number,
    readonly nodeQuorumThreshold: number,
    readonly retries: number,
    readonly delay: number,
    readonly maxConcurrency: number,
    providerCacheNamespace: string,
    pctRpcCallsLogged: number,
    redisClient?: RedisClient,
    standardTtlBlockDistance?: number,
    noTtlBlockDistance?: number
  ) {
    // Initialize the super just with the chainId, which stops it from trying to immediately send out a .send before
    // this derived class is initialized.
    super(undefined, chainId);
    this.providers = params.map(
      (inputs) =>
        new CacheProvider(
          providerCacheNamespace,
          redisClient,
          standardTtlBlockDistance,
          noTtlBlockDistance,
          maxConcurrency,
          pctRpcCallsLogged,
          ...inputs
        )
    );
    if (this.nodeQuorumThreshold < 1 || !Number.isInteger(this.nodeQuorumThreshold)) {
      throw new Error(
        `nodeQuorum,Threshold cannot be < 1 and must be an integer. Currently set to ${this.nodeQuorumThreshold}`
      );
    }
    if (this.retries < 0 || !Number.isInteger(this.retries)) {
      throw new Error(`retries cannot be < 0 and must be an integer. Currently set to ${this.retries}`);
    }
    if (this.delay < 0) {
      throw new Error(`delay cannot be < 0. Currently set to ${this.delay}`);
    }
    if (this.nodeQuorumThreshold > this.providers.length) {
      throw new Error(
        `nodeQuorumThreshold (${this.nodeQuorumThreshold}) must be <= the number of providers (${this.providers.length})`
      );
    }
  }

  override async send(method: string, params: Array<any>): Promise<any> {
    const quorumThreshold = this._getQuorum(method, params);
    const requiredProviders = this.providers.slice(0, quorumThreshold);
    const fallbackProviders = this.providers.slice(quorumThreshold);
    const errors: [ethers.providers.StaticJsonRpcProvider, string][] = [];

    // This function is used to try to send with a provider and if it fails pop an element off the fallback list to try
    // with that one. Once the fallback provider list is empty, the method throws. Because the fallback providers are
    // removed, we ensure that no provider is used more than once because we care about quorum, making sure all
    // considered responses come from unique providers.
    const tryWithFallback = (
      provider: ethers.providers.StaticJsonRpcProvider
    ): Promise<[ethers.providers.StaticJsonRpcProvider, any]> => {
      return this._trySend(provider, method, params)
        .then((result): [ethers.providers.StaticJsonRpcProvider, any] => [provider, result])
        .catch((err) => {
          // Append the provider and error to the error array.
          errors.push([provider, err?.stack || err?.toString()]);

          // If there are no new fallback providers to use, terminate the recursion by throwing an error.
          // Otherwise, we can try to call another provider.
          if (fallbackProviders.length === 0) {
            throw err;
          }

          // This line does two things:
          // 1. Removes a fallback provider from the array so it cannot be used as a fallback for another required
          // provider.
          // 2. Recursively calls this method with that provider so it goes through the same try logic as the previous one.
          return tryWithFallback(fallbackProviders.shift());
        });
    };

    const results = await Promise.allSettled(requiredProviders.map(tryWithFallback));

    if (!results.every(isPromiseFulfilled)) {
      // Format the error so that it's very clear which providers failed and succeeded.
      const errorTexts = errors.map(([provider, errorText]) => formatProviderError(provider, errorText));
      const successfulProviderUrls = results.filter(isPromiseFulfilled).map((result) => result.value[0].connection.url);
      throw createSendErrorWithMessage(
        `Not enough providers succeeded. Errors:\n${errorTexts.join("\n")}\n` +
          `Successful Providers:\n${successfulProviderUrls.join("\n")}`,
        results.find(isPromiseRejected).reason
      );
    }

    const values = results.map((result) => result.value);

    // Start at element 1 and begin comparing.
    // If _all_ values are equal, we have hit quorum, so return.
    if (values.slice(1).every(([, output]) => compareRpcResults(method, values[0][1], output))) {
      return values[0][1];
    }

    const throwQuorumError = () => {
      const errorTexts = errors.map(([provider, errorText]) => formatProviderError(provider, errorText));
      const successfulProviderUrls = values.map(([provider]) => provider.connection.url);
      throw new Error(
        "Not enough providers agreed to meet quorum.\n" +
          "Providers that errored:\n" +
          `${errorTexts.join("\n")}\n` +
          "Providers that succeeded, but some failed to match:\n" +
          successfulProviderUrls.join("\n")
      );
    };

    // Exit early if there are no fallback providers left.
    if (fallbackProviders.length === 0) {
      throwQuorumError();
    }

    // Try each fallback provider in parallel.
    const fallbackResults = await Promise.allSettled(
      fallbackProviders.map((provider) =>
        this._trySend(provider, method, params)
          .then((result): [ethers.providers.StaticJsonRpcProvider, any] => [provider, result])
          .catch((err) => {
            errors.push([provider, err?.stack || err?.toString()]);
            throw new Error("No fallbacks during quorum search");
          })
      )
    );

    // This filters only the fallbacks that succeeded.
    const fallbackValues = fallbackResults.filter(isPromiseFulfilled).map((promise) => promise.value);

    // Group the results by the count of that result.
    const counts = [...values, ...fallbackValues].reduce(
      (acc, curr) => {
        const [, result] = curr;

        // Find the first result that matches the return value.
        const existingMatch = acc.find(([existingResult]) => compareRpcResults(method, existingResult, result));

        // Increment the count if a match is found, else add a new element to the match array with a count of 1.
        if (existingMatch) {
          existingMatch[1]++;
        } else {
          acc.push([result, 1]);
        }

        // Return the same acc object because it was modified in place.
        return acc;
      },
      [[undefined, 0]] as [any, number][] // Initialize with [undefined, 0] as the first element so something is always returned.
    );

    // Sort so the result with the highest count is first.
    counts.sort(([, a], [, b]) => b - a);

    // Extract the result by grabbing the first element.
    const [quorumResult, count] = counts[0];

    // If this count is less than we need for quorum, throw the quorum error.
    if (count < quorumThreshold) {
      throwQuorumError();
    }

    // If we've achieved quorum, then we should still log the providers that mismatched with the quorum result.
    const mismatchedProviders = Object.fromEntries(
      [...values, ...fallbackValues]
        .filter(([, result]) => !compareRpcResults(method, result, quorumResult))
        .map(([provider, result]) => [provider.connection.url, result])
    );
    const quorumProviders = [...values, ...fallbackValues]
      .filter(([, result]) => compareRpcResults(method, result, quorumResult))
      .map(([provider]) => provider.connection.url);
    if (Object.keys(mismatchedProviders).length > 0 || errors.length > 0) {
      logger.warn({
        at: "ProviderUtils",
        message: "Some providers mismatched with the quorum result or failed 🚸",
        notificationPath: "across-warn",
        method,
        params,
        quorumProviders,
        mismatchedProviders,
        erroringProviders: errors.map(([provider, errorText]) => formatProviderError(provider, errorText)),
      });
    }

    return quorumResult;
  }

  _validateResponse(method: string, params: Array<any>, response: any): boolean {
    // Basic validation logic to start.
    // Note: eth_getTransactionReceipt is ignored here because null responses are expected in the case that ethers is
    // polling for the transaction receipt and receiving null until it does.
    return isDefined(response) || method === "eth_getTransactionReceipt";
  }

  async _sendAndValidate(
    provider: ethers.providers.StaticJsonRpcProvider,
    method: string,
    params: Array<any>
  ): Promise<any> {
    const response = await provider.send(method, params);
    if (!this._validateResponse(method, params, response)) {
      // Not a warning to avoid spam since this could trigger a lot.
      logger.debug({
        at: "ProviderUtils",
        message: "Provider returned invalid response",
        provider: getOriginFromURL(provider.connection.url),
        method,
        params,
        response,
      });
      throw new Error("Response failed validation");
    }
    return response;
  }

  _trySend(provider: ethers.providers.StaticJsonRpcProvider, method: string, params: Array<any>): Promise<any> {
    let promise = this._sendAndValidate(provider, method, params);
    for (let i = 0; i < this.retries; i++) {
      promise = promise.catch(() => delay(this.delay).then(() => this._sendAndValidate(provider, method, params)));
    }
    return promise;
  }

  _getQuorum(method: string, params: Array<any>): number {
    // Only use quorum if this is a historical query that doesn't depend on the current block number.

    // All logs queries should use quorum.
    if (method === "eth_getLogs") {
      return this.nodeQuorumThreshold;
    }

    // getBlockByNumber should only use the quorum if it's not asking for the latest block.
    if (method === "eth_getBlockByNumber" && params[0] !== "latest") {
      return this.nodeQuorumThreshold;
    }

    // eth_call should only use quorum for queries at a specific past block.
    if (method === "eth_call" && params[1] !== "latest") {
      return this.nodeQuorumThreshold;
    }

    // All other calls should use quorum 1 to avoid errors due to sync differences.
    return 1;
  }
}

// Global provider cache to avoid creating multiple providers for the same chain.
const providerCache: { [chainId: number]: RetryProvider } = {};

function getProviderCacheKey(chainId: number, redisEnabled) {
  return `${chainId}_${redisEnabled ? "cache" : "nocache"}`;
}

/**
 * @notice should be used after `getProvider` has been called once to fetch an already cached provider.
 * This will never return undefined since it will throw if the requested provider hasn't been cached.
 * @param chainId
 * @param redisEnabled
 * @returns ethers.provider
 */
export function getCachedProvider(chainId: number, redisEnabled = true): RetryProvider {
  if (!providerCache[getProviderCacheKey(chainId, redisEnabled)]) {
    throw new Error(`No cached provider for chainId ${chainId} and redisEnabled ${redisEnabled}`);
  }
  return providerCache[getProviderCacheKey(chainId, redisEnabled)];
}

/**
 * Return the env-defined quorum configured for `chainId`, or 1 if no quorum has been defined.
 * @param chainId Chain ID to query for quorum.
 * @returns Applicable quorum.
 */
export function getChainQuorum(chainId: number): number {
  return Number(process.env[`NODE_QUORUM_${chainId}`] || process.env.NODE_QUORUM || "1");
}

/**
 * @notice Returns retry provider for specified chain ID. Optimistically tries to instantiate the provider
 * with a redis client attached so that all RPC requests are cached. Will load the provider from an in memory
 * "provider cache" if this function was called once before with the same chain ID.
 */
export async function getProvider(chainId: number, logger?: winston.Logger, useCache = true): Promise<RetryProvider> {
  const redisClient = await getRedis(logger);
  if (useCache) {
    const cachedProvider = providerCache[getProviderCacheKey(chainId, redisClient !== undefined)];
    if (cachedProvider) {
      return cachedProvider;
    }
  }
  const {
    NODE_RETRIES,
    NODE_RETRY_DELAY,
    NODE_TIMEOUT,
    NODE_MAX_CONCURRENCY,
    NODE_DISABLE_PROVIDER_CACHING,
    NODE_PROVIDER_CACHE_NAMESPACE,
    NODE_LOG_EVERY_N_RATE_LIMIT_ERRORS,
    NODE_DISABLE_INFINITE_TTL_PROVIDER_CACHING,
    NODE_PCT_RPC_CALLS_LOGGED,
  } = process.env;

  const timeout = Number(process.env[`NODE_TIMEOUT_${chainId}`] || NODE_TIMEOUT || defaultTimeout);

  // Default to 2 retries.
  const retries = Number(process.env[`NODE_RETRIES_${chainId}`] || NODE_RETRIES || "2");

  // Default to a delay of 1 second between retries.
  const retryDelay = Number(process.env[`NODE_RETRY_DELAY_${chainId}`] || NODE_RETRY_DELAY || "1");

  const nodeQuorumThreshold = getChainQuorum(chainId);

  const nodeMaxConcurrency = Number(process.env[`NODE_MAX_CONCURRENCY_${chainId}`] || NODE_MAX_CONCURRENCY || "25");

  const disableNoTtlCaching = NODE_DISABLE_INFINITE_TTL_PROVIDER_CACHING === "true";

  // Note: if there is no env var override _and_ no default, this will remain undefined and
  // effectively disable indefinite caching of old blocks/keys.
  const noTtlBlockDistanceKey = `NO_TTL_BLOCK_DISTANCE_${chainId}`;
  const noTtlBlockDistance: number | undefined = process.env[noTtlBlockDistanceKey]
    ? Number(process.env[noTtlBlockDistanceKey])
    : DEFAULT_NO_TTL_DISTANCE[chainId];

  // If on a production chain, a chain follow distance must be defined.
  if (Object.values(MAINNET_CHAIN_IDs).includes(chainId) && CHAIN_CACHE_FOLLOW_DISTANCE[chainId] === undefined) {
    throw new Error(`CHAIN_CACHE_FOLLOW_DISTANCE[${chainId}] not defined.`);
  }

  // If not operating on a production chain and this chain has no follow distance defined, default to 0 (cache
  // everything).
  const standardTtlBlockDistance: number | undefined = CHAIN_CACHE_FOLLOW_DISTANCE[chainId] || 0;

  // Provider caching defaults to being enabled if a redis instance exists. It can be manually disabled by setting
  // NODE_DISABLE_PROVIDER_CACHING=true.
  // This only disables standard TTL caching for blocks close to HEAD.
  // To disable all caching, this option should be combined with NODE_DISABLE_NO_TTL_PROVIDER_CACHING or
  // the user should refrain from providing a valid redis instance.
  const disableProviderCache = NODE_DISABLE_PROVIDER_CACHING === "true";

  // This environment variable allows the operator to namespace the cache. This is useful if multiple bots are using
  // the cache and the operator intends to have them not share.
  // It's also useful as a way to synthetically "flush" the provider cache by modifying this value.
  // A recommended naming strategy is "NAME_X" where NAME is a string name and 0 is a numerical value that can be
  // adjusted for the purpose of "flushing".
  const providerCacheNamespace = NODE_PROVIDER_CACHE_NAMESPACE || "DEFAULT_0";

  const logEveryNRateLimitErrors = Number(NODE_LOG_EVERY_N_RATE_LIMIT_ERRORS || "100");

  const pctRpcCallsLogged = Number(
    process.env[`NODE_PCT_RPC_CALLS_LOGGED_${chainId}`] || NODE_PCT_RPC_CALLS_LOGGED || "0"
  );

  // Custom delay + logging for RPC rate-limiting.
  let rateLimitLogCounter = 0;
  const rpcRateLimited =
    ({ nodeMaxConcurrency, logger }) =>
    async (attempt: number, url: string): Promise<boolean> => {
      // Implement a slightly aggressive expontential backoff to account for fierce paralellism.
      // @todo: Start w/ maxConcurrency low and increase until 429 responses start arriving.
      const baseDelay = 1000 * Math.pow(2, attempt); // ms; attempt = [0, 1, 2, ...]
      const delayMs = baseDelay + baseDelay * Math.random();

      if (logger && rateLimitLogCounter++ % logEveryNRateLimitErrors === 0) {
        logger.debug({
          at: "ProviderUtils#rpcRateLimited",
          message: `Got rate-limit (429) response on attempt ${attempt}.`,
          rpc: getOriginFromURL(url),
          retryAfter: `${delayMs} ms`,
          workers: nodeMaxConcurrency,
        });
      }
      await delay(delayMs);

      return attempt < retries;
    };

  // See ethers ConnectionInfo for field descriptions.
  // https://docs.ethers.org/v5/api/utils/web/#ConnectionInfo
  const constructorArgumentLists = getNodeUrlList(chainId, nodeQuorumThreshold).map(
    (nodeUrl): [ethers.utils.ConnectionInfo, number] => [
      {
        url: nodeUrl,
        timeout,
        allowGzip: true,
        throttleSlotInterval: 1, // Effectively disables ethers' internal backoff algorithm.
        throttleCallback: rpcRateLimited({ nodeMaxConcurrency, logger }),
      },
      chainId,
    ]
  );

  const provider = new RetryProvider(
    constructorArgumentLists,
    chainId,
    nodeQuorumThreshold,
    retries,
    retryDelay,
    nodeMaxConcurrency,
    providerCacheNamespace,
    pctRpcCallsLogged,
    redisClient,
    disableProviderCache ? undefined : standardTtlBlockDistance,
    disableNoTtlCaching ? undefined : noTtlBlockDistance
  );

  if (useCache) {
    providerCache[getProviderCacheKey(chainId, redisClient !== undefined)] = provider;
  }
  return provider;
}

export function getWSProviders(chainId: number, quorum?: number): ethers.providers.WebSocketProvider[] {
  quorum ??= getChainQuorum(chainId);
  const urls = getNodeUrlList(chainId, quorum, "wss");
  return urls.map((url) => new ethers.providers.WebSocketProvider(url));
}

export function getNodeUrlList(chainId: number, quorum = 1, protocol: "https" | "wss" = "https"): string[] {
  const resolveUrls = (): string[] => {
    const [envPrefix, providerPrefix] =
      protocol === "https" ? ["RPC_PROVIDERS", "RPC_PROVIDER"] : ["RPC_WS_PROVIDERS", "RPC_WS_PROVIDER"];

    const providers = process.env[`${envPrefix}_${chainId}`] ?? process.env[envPrefix];
    if (providers === undefined) {
      throw new Error(`No RPC providers defined for chainId ${chainId}`);
    }

    const nodeUrls = providers.split(",").map((provider) => {
      const envVar = `${providerPrefix}_${provider}_${chainId}`;
      const url = process.env[envVar];
      if (url === undefined) {
        throw new Error(`Missing RPC provider URL for chain ${chainId} (${envVar})`);
      }
      return url;
    });

    if (nodeUrls.length === 0) {
      throw new Error(`Missing configuration for chainId ${chainId} providers (${providers})`);
    }

    return nodeUrls;
  };

  const nodeUrls = resolveUrls();
  if (nodeUrls.length < quorum) {
    throw new Error(`Insufficient RPC providers for chainId ${chainId} to meet quorum (minimum ${quorum} required)`);
  }

  return nodeUrls;
}

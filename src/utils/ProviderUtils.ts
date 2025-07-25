import { MAINNET_CHAIN_IDs } from "@across-protocol/constants";
import { providers as sdkProviders } from "@across-protocol/sdk";
import { ethers } from "ethers";
import winston from "winston";
import { CHAIN_CACHE_FOLLOW_DISTANCE, DEFAULT_NO_TTL_DISTANCE } from "../common";
import { delay, getOriginFromURL, Logger, SVMProvider } from "./";
import { getRedisCache } from "./RedisUtils";
import { isDefined } from "./TypeGuards";
import * as viem from "viem";

export const defaultTimeout = 60 * 1000;
export class RetryProvider extends sdkProviders.RetryProvider {}

// Global provider cache to avoid creating multiple providers for the same chain.
const providerCache: { [chainId: number]: RetryProvider } = {};

function getProviderCacheKey(chainId: number, redisEnabled: boolean) {
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

export function isJsonRpcError(response: unknown): { code: number; message: string; data?: unknown } | undefined {
  if (!sdkProviders.RpcError.is(response)) {
    return;
  }

  try {
    const error = JSON.parse(response.body);
    if (!sdkProviders.JsonRpcError.is(error)) {
      return;
    }

    return error.error;
  } catch {
    return;
  }
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
 * Permit env-based HTTP headers to be specified.
 * RPC_PROVIDER_<provider>_<chainId>_HEADERS=auth
 * RPC_PROVIDER_<provider>_<chainId>_HEADER_AUTH=xxx-auth-header
 */
export function getProviderHeaders(provider: string, chainId: number): { [header: string]: string } | undefined {
  let headers: { [k: string]: string };
  const _headers = process.env[`RPC_PROVIDER_${provider}_${chainId}_HEADERS`];
  _headers?.split(",").forEach((header) => {
    headers ??= {};
    headers[header] = process.env[`RPC_PROVIDER_${provider}_${chainId}_HEADER_${header.toUpperCase()}`];
  });

  return headers;
}

function getMaxConcurrency(chainId: number): number {
  const { NODE_MAX_CONCURRENCY = "25" } = process.env;
  return Number(process.env[`NODE_MAX_CONCURRENCY_${chainId}`] ?? NODE_MAX_CONCURRENCY);
}

function getPctRpcCallsLogged(chainId: number): number {
  const { NODE_PCT_RPC_CALLS_LOGGED = "0" } = process.env;
  return Number(process.env[`NODE_PCT_RPC_CALLS_LOGGED_${chainId}`] ?? NODE_PCT_RPC_CALLS_LOGGED);
}

// This environment variable allows the operator to namespace the cache. This is useful if multiple bots are using
// the cache and the operator intends to have them not share.
// It's also useful as a way to synthetically "flush" the provider cache by modifying this value.
// A recommended naming strategy is "NAME_X" where NAME is a string name and 0 is a numerical value that can be
// adjusted for the purpose of "flushing".
function getCacheNamespace(chainId: number): string {
  const { NODE_PROVIDER_CACHE_NAMESPACE = "DEFAULT_0" } = process.env;
  return process.env[`NODE_PROVIDER_CACHE_NAMESPACE_${chainId}`] ?? NODE_PROVIDER_CACHE_NAMESPACE;
}

function getRetryParams(chainId: number): { retries: number; retryDelay: number } {
  const { NODE_RETRIES, NODE_RETRY_DELAY } = process.env;
  return {
    // Default to 2 retries.
    retries: Number(process.env[`NODE_RETRIES_${chainId}`] || NODE_RETRIES || "2"),
    // Default to a delay of 1 second between retries.
    retryDelay: Number(process.env[`NODE_RETRY_DELAY_${chainId}`] || NODE_RETRY_DELAY || "1"),
  };
}

/**
 * @notice Returns retry provider for specified chain ID. Optimistically tries to instantiate the provider
 * with a redis client attached so that all RPC requests are cached. Will load the provider from an in memory
 * "provider cache" if this function was called once before with the same chain ID.
 */
export async function getProvider(
  chainId: number,
  logger: winston.Logger = Logger,
  useCache = true
): Promise<RetryProvider> {
  const redisClient = await getRedisCache(logger);
  if (useCache) {
    const cachedProvider = providerCache[getProviderCacheKey(chainId, redisClient !== undefined)];
    if (cachedProvider) {
      return cachedProvider;
    }
  }
  const {
    NODE_TIMEOUT,
    NODE_DISABLE_PROVIDER_CACHING,
    NODE_LOG_EVERY_N_RATE_LIMIT_ERRORS,
    NODE_DISABLE_INFINITE_TTL_PROVIDER_CACHING,
    PROVIDER_CACHE_TTL,
  } = process.env;

  const timeout = Number(process.env[`NODE_TIMEOUT_${chainId}`] || NODE_TIMEOUT || defaultTimeout);

  const { retries, retryDelay } = getRetryParams(chainId);

  const nodeQuorumThreshold = getChainQuorum(chainId);

  const nodeMaxConcurrency = getMaxConcurrency(chainId);

  const disableNoTtlCaching = NODE_DISABLE_INFINITE_TTL_PROVIDER_CACHING === "true";

  const providerCacheTtl = PROVIDER_CACHE_TTL ? Number(PROVIDER_CACHE_TTL) : undefined;

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

  const providerCacheNamespace = getCacheNamespace(chainId);

  const logEveryNRateLimitErrors = Number(NODE_LOG_EVERY_N_RATE_LIMIT_ERRORS || "100");

  const pctRpcCallsLogged = getPctRpcCallsLogged(chainId);

  // Custom delay + logging for RPC rate-limiting.
  let rateLimitLogCounter = 0;
  const rpcRateLimited =
    ({ nodeMaxConcurrency, logger }) =>
    async (attempt: number, url: string): Promise<boolean> => {
      // Implement a slightly aggressive exponential backoff to account for fierce parallelism.
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
          datadog: true,
        });
      }
      await delay(delayMs);

      return attempt < retries;
    };

  // See ethers ConnectionInfo for field descriptions.
  // https://docs.ethers.org/v5/api/utils/web/#ConnectionInfo

  const constructorArgumentLists = Object.entries(getNodeUrlList(chainId, nodeQuorumThreshold)).map(
    ([provider, url]): [ethers.utils.ConnectionInfo, number] => {
      const config = {
        url,
        headers: getProviderHeaders(provider, chainId),
        timeout,
        allowGzip: true,
        throttleSlotInterval: 1, // Effectively disables ethers' internal backoff algorithm.
        throttleCallback: rpcRateLimited({ nodeMaxConcurrency, logger }),
        errorPassThrough: true,
      };

      return [config, chainId];
    }
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
    disableNoTtlCaching ? undefined : noTtlBlockDistance,
    providerCacheTtl,
    logger
  );

  if (useCache) {
    providerCache[getProviderCacheKey(chainId, redisClient !== undefined)] = provider;
  }
  return provider;
}

/**
 * @notice Returns a Viem custom transport that can be used to create a Viem client from our customized Ethers
 * provider. This allows us to send requests through our RetryProvider that need to be handled by Viem SDK's.
 */
export function createViemCustomTransportFromEthersProvider(providerChainId: number): viem.CustomTransport {
  return viem.custom(
    {
      async request({ method, params }) {
        const provider = getCachedProvider(providerChainId, true);
        try {
          return await provider.send(method, params);
        } catch (error: any) {
          // Ethers encodes RPC errors differently than Viem expects it so if the error is a JSON RPC error,
          // decode it in a way that Viem can gracefully handle.
          if (isJsonRpcError(error)) {
            throw error.error;
          } else {
            throw error;
          }
        }
      },
    },
    {
      // Viem has many native options that we can use to replicate our ethers' RetryProvider but the easiest
      // way to  migrate for now is to force all requests through our RetryProvider and disable all retry, quorum,
      // caching, and other logic in the Viem transport.
      retryCount: 0,
    }
  );
}

export function getWSProviders(chainId: number, quorum?: number): ethers.providers.WebSocketProvider[] {
  quorum ??= getChainQuorum(chainId);
  const urls = getNodeUrlList(chainId, quorum, "wss");
  return Object.values(urls).map((url) => new ethers.providers.WebSocketProvider(url));
}

/**
 * @notice Returns a cached SVMProvider.
 */
export function getSvmProvider(logger: winston.Logger = Logger, chainId = MAINNET_CHAIN_IDs.SOLANA): SVMProvider {
  const nodeUrlList = getNodeUrlList(chainId);
  const namespace = getCacheNamespace(chainId);
  const maxConcurrency = getMaxConcurrency(chainId);
  const pctRpcCallsLogged = getPctRpcCallsLogged(chainId);
  const { retries, retryDelay } = getRetryParams(chainId);
  const providerFactory = new sdkProviders.CachedSolanaRpcFactory(
    namespace,
    undefined, // redisClient
    // @dev: We are not using a redis client for the SVMProvider because it doesn't seem to work currently.
    retries,
    retryDelay,
    maxConcurrency,
    pctRpcCallsLogged,
    logger,
    Object.values(nodeUrlList)[0],
    chainId
  );
  return providerFactory.createRpcClient();
}

export function getNodeUrlList(
  chainId: number,
  quorum = 1,
  transport: sdkProviders.RPCTransport = "https"
): { [provider: string]: string } {
  const resolveUrls = (): { [provider: string]: string } => {
    const [envPrefix, providerPrefix] =
      transport === "https" ? ["RPC_PROVIDERS", "RPC_PROVIDER"] : ["RPC_WS_PROVIDERS", "RPC_WS_PROVIDER"];

    const providers = process.env[`${envPrefix}_${chainId}`] ?? process.env[envPrefix];
    if (providers === undefined) {
      throw new Error(`No RPC providers defined for chainId ${chainId}`);
    }

    const nodeUrls = Object.fromEntries(
      providers.split(",").map((provider) => {
        // If no specific RPC endpoint is identified for this provider, try to
        // to infer the endpoint name based on predefined chain definitions.
        const apiKey = process.env[`RPC_PROVIDER_KEY_${provider}`];
        const envVar = `${providerPrefix}_${provider}_${chainId}`;
        let url = process.env[envVar];
        if (!isDefined(url) && isDefined(apiKey) && sdkProviders.isSupportedProvider(provider)) {
          url = sdkProviders.getURL(provider, chainId, apiKey, transport);
        }

        if (url === undefined) {
          throw new Error(`Missing RPC provider URL for chain ${chainId} (${envVar})`);
        }
        return [provider, url];
      })
    );

    if (Object.keys(nodeUrls).length === 0) {
      throw new Error(`Missing configuration for chainId ${chainId} providers (${providers})`);
    }

    return nodeUrls;
  };

  const nodeUrls = resolveUrls();
  if (Object.keys(nodeUrls).length < quorum) {
    throw new Error(`Insufficient RPC providers for chainId ${chainId} to meet quorum (minimum ${quorum} required)`);
  }

  return nodeUrls;
}

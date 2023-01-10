import { ethers } from "ethers";
import lodash from "lodash";
import winston from "winston";
import { isPromiseFulfulled, isPromiseRejected } from "./TypeGuards";
import createQueue, { QueueObject } from "async/queue";
import { Logger } from ".";

const logger = Logger;

// The async/queue library has a task-based interface for building a concurrent queue.
// This is the type we pass to define a request "task".
interface RateLimitTask {
  // These are the arguments to be passed to super.send().
  sendArgs: [string, Array<any>];

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
    ...jsonRpcConstructorParams: ConstructorParameters<typeof ethers.providers.StaticJsonRpcProvider>
  ) {
    super(...jsonRpcConstructorParams);

    // This sets up the queue. Each task is executed by calling the superclass's send method, which fires off the
    // request. This queue sends out requests concurrently, but stops once the concurrency limit is reached. The
    // maxConcurrency is configured here.
    this.queue = createQueue(async ({ sendArgs, resolve, reject }: RateLimitTask) => {
      await super
        .send(...sendArgs)
        .then(resolve)
        .catch(reject);
    }, maxConcurrency);
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

function delay(s: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, Math.round(s * 1000)));
}

function formatProviderError(provider: ethers.providers.StaticJsonRpcProvider, rawErrorText: string) {
  return `Provider ${provider.connection.url} failed with error: ${rawErrorText}`;
}

function createSendErrorWithMessage(message: string, sendError: any) {
  const error = new Error(message);
  return { ...sendError, ...error };
}

function compareRpcResults(method: string, rpcResultA: any, rpcResultB: any): boolean {
  // This function mutates rpcResults and deletes the ignored keys. It returns the deleted keys that we can re-add
  // back after we do the comparison with unignored keys. This is a faster algorithm than cloning an object but it has
  // some side effects such as the order of keys in the rpcResults object changing.
  const deleteIgnoredKeys = (ignoredKeys: string[], rpcResults: any) => {
    const ignoredMappings = {};
    for (const key of ignoredKeys) {
      ignoredMappings[key] = rpcResults[key];
      delete rpcResults[key];
    }
    return ignoredMappings;
  };
  const addIgnoredFilteredKeys = (ignoredMappings: any, rpcResults: any) => {
    for (const [key, value] of Object.entries(ignoredMappings)) {
      rpcResults[key] = value;
    }
  };

  if (method === "eth_getBlockByNumber") {
    // We've seen RPC's disagree on the miner field, for example when Polygon nodes updated software that
    // led alchemy and quicknode to disagree on the the miner field's value.
    const ignoredKeys = ["miner"];
    const ignoredMappingsA = deleteIgnoredKeys(ignoredKeys, rpcResultA);
    const ignoredMappingsB = deleteIgnoredKeys(ignoredKeys, rpcResultB);
    const result = lodash.isEqual(rpcResultA, rpcResultB);
    addIgnoredFilteredKeys(ignoredMappingsA, rpcResultA);
    addIgnoredFilteredKeys(ignoredMappingsB, rpcResultB);
    return result;
  } else {
    return lodash.isEqual(rpcResultA, rpcResultB);
  }
}

class RetryProvider extends ethers.providers.StaticJsonRpcProvider {
  readonly providers: ethers.providers.StaticJsonRpcProvider[];
  constructor(
    params: ConstructorParameters<typeof ethers.providers.StaticJsonRpcProvider>[],
    chainId: number,
    readonly nodeQuorumThreshold: number,
    readonly retries: number,
    readonly delay: number,
    readonly maxConcurrency: number
  ) {
    // Initialize the super just with the chainId, which stops it from trying to immediately send out a .send before
    // this derived class is initialized.
    super(undefined, chainId);
    this.providers = params.map((inputs) => new RateLimitedProvider(maxConcurrency, ...inputs));
    if (this.nodeQuorumThreshold < 1 || !Number.isInteger(this.nodeQuorumThreshold))
      throw new Error(
        `nodeQuorum,Threshold cannot be < 1 and must be an integer. Currently set to ${this.nodeQuorumThreshold}`
      );
    if (this.retries < 0 || !Number.isInteger(this.retries))
      throw new Error(`retries cannot be < 0 and must be an integer. Currently set to ${this.retries}`);
    if (this.delay < 0) throw new Error(`delay cannot be < 0. Currently set to ${this.delay}`);
    if (this.nodeQuorumThreshold > this.providers.length)
      throw new Error(
        `nodeQuorumThreshold (${this.nodeQuorumThreshold}) must be <= the number of providers (${this.providers.length})`
      );
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

    if (!results.every(isPromiseFulfulled)) {
      // Format the error so that it's very clear which providers failed and succeeded.
      const errorTexts = errors.map(([provider, errorText]) => formatProviderError(provider, errorText));
      const successfulProviderUrls = results.filter(isPromiseFulfulled).map((result) => result.value[0].connection.url);
      throw createSendErrorWithMessage(
        `Not enough providers succeeded. Errors:\n${errorTexts.join("\n")}\n` +
          `Successful Providers:\n${successfulProviderUrls.join("\n")}`,
        results.find(isPromiseRejected).reason
      );
    }

    const values = results.map((result) => result.value);

    // Start at element 1 and begin comparing.
    // If _all_ values are equal, we have hit quorum, so return.
    if (values.slice(1).every(([, output]) => compareRpcResults(method, values[0][1], output))) return values[0][1];

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
    if (fallbackProviders.length === 0) throwQuorumError();

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
    const fallbackValues = fallbackResults.filter(isPromiseFulfulled).map((promise) => promise.value);

    // Group the results by the count of that result.
    const counts = [...values, ...fallbackValues].reduce(
      (acc, curr) => {
        const [, result] = curr;

        // Find the first result that matches the return value.
        const existingMatch = acc.find(([existingResult]) => compareRpcResults(method, existingResult, result));

        // Increment the count if a match is found, else add a new element to the match array with a count of 1.
        if (existingMatch) existingMatch[1]++;
        else acc.push([result, 1]);

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
    if (count < quorumThreshold) throwQuorumError();

    // If we've achieved quorum, then we should still log the providers that mismatched with the quorum result.
    const mismatchedProviders = [...values, ...fallbackValues]
      .filter(([, result]) => !compareRpcResults(method, result, quorumResult))
      .map(([provider]) => provider.connection.url);
    const quorumProviders = [...values, ...fallbackValues]
      .filter(([, result]) => compareRpcResults(method, result, quorumResult))
      .map(([provider]) => provider.connection.url);
    if (mismatchedProviders.length > 0 || errors.length > 0) {
      logger.warn({
        at: "ProviderUtils",
        message: "Some providers mismatched with the quorum result or failed 🚸",
        method,
        params,
        quorumProviders,
        mismatchedProviders,
        erroringProviders: errors.map(([provider, errorText]) => formatProviderError(provider, errorText)),
      });
    }

    return quorumResult;
  }

  _trySend(provider: ethers.providers.StaticJsonRpcProvider, method: string, params: Array<any>): Promise<any> {
    let promise = provider.send(method, params);
    for (let i = 0; i < this.retries; i++) {
      promise = promise.catch(() => delay(this.delay).then(() => provider.send(method, params)));
    }
    return promise;
  }

  _getQuorum(method: string, params: Array<any>): number {
    // Only use quorum if this is a historical query that doesn't depend on the current block number.

    // All logs queries should use quorum.
    if (method === "eth_getLogs") return this.nodeQuorumThreshold;

    // getBlockByNumber should only use the quorum if it's not asking for the latest block.
    if (method === "eth_getBlockByNumber" && params[0] !== "latest") return this.nodeQuorumThreshold;

    // eth_call should only use quorum for queries at a specific past block.
    if (method === "eth_call" && params[1] !== "latest") return this.nodeQuorumThreshold;

    // All other calls should use quorum 1 to avoid errors due to sync differences.
    return 1;
  }
}

export function getProvider(chainId: number, logger?: winston.Logger) {
  const { NODE_RETRIES, NODE_RETRY_DELAY, NODE_QUORUM, NODE_TIMEOUT, NODE_MAX_CONCURRENCY } = process.env;

  const timeout = Number(process.env[`NODE_TIMEOUT_${chainId}`] || NODE_TIMEOUT || defaultTimeout);

  // Default to 2 retries.
  const retries = Number(process.env[`NODE_RETRIES_${chainId}`] || NODE_RETRIES || "2");

  // Default to a delay of 1 second between retries.
  const retryDelay = Number(process.env[`NODE_RETRY_DELAY_${chainId}`] || NODE_RETRY_DELAY || "1");

  // Default to a node quorum of 1 node.
  const nodeQuorumThreshold = Number(process.env[`NODE_QUORUM_${chainId}`] || NODE_QUORUM || "1");

  // Default to a max concurrency of 1000 requests per node.
  const nodeMaxConcurrency = Number(process.env[`NODE_MAX_CONCURRENCY_${chainId}`] || NODE_MAX_CONCURRENCY || "1000");

  const sleep = async (duration: number): Promise<number> => {
    const startMs = Date.now();
    await new Promise((resolve) => setTimeout(resolve, duration));
    return Date.now() - startMs;
  };

  // Custom delay + logging for RPC rate-limiting.
  const rpcRateLimited =
    ({ nodeMaxConcurrency, logger }) =>
    async (attempt: number, url: string): Promise<boolean> => {
      const baseDelay = 1000 * Math.pow(2, attempt); // ms; attempt = [0, 1, 2, ...]
      const delayMs = await sleep(baseDelay + baseDelay * Math.random());

      if (logger) {
        // Make an effort to filter out any api keys.
        const regex = url.match(/https?:\/\/([\w.-]+)\/.*/);
        logger.debug({
          at: "ProviderUtils#rpcRateLimited",
          message: `Got 429 on attempt ${attempt}.`,
          rpc: regex ? regex[1] : url,
          retryAfter: `${delayMs} ms`,
          workers: nodeMaxConcurrency,
        });
      }

      return attempt < retries;
    };

  const constructorArgumentLists = getNodeUrlList(chainId).map((nodeUrl): [ethers.utils.ConnectionInfo, number] => [
    {
      url: nodeUrl,
      timeout,
      allowGzip: true,
      throttleSlotInterval: 1,
      throttleCallback: rpcRateLimited({ nodeMaxConcurrency, logger }),
    },
    chainId,
  ]);

  return new RetryProvider(
    constructorArgumentLists,
    chainId,
    nodeQuorumThreshold,
    retries,
    retryDelay,
    nodeMaxConcurrency
  );
}

export function getNodeUrlList(chainId: number): string[] {
  const retryConfigKey = `NODE_URLS_${chainId}`;
  if (process.env[retryConfigKey]) {
    const nodeUrls = JSON.parse(process.env[retryConfigKey]) || [];
    if (nodeUrls?.length === 0)
      throw new Error(`Provided ${retryConfigKey}, but parsing it as json did not result in an array of urls.`);
    return nodeUrls;
  }

  const nodeUrlKey = `NODE_URL_${chainId}`;

  if (process.env[nodeUrlKey]) {
    return [process.env[nodeUrlKey]];
  }

  throw new Error(
    `Cannot get node url(s) for ${chainId} because neither ${retryConfigKey} or ${nodeUrlKey} were provided.`
  );
}

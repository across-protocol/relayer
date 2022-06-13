import { ethers } from "ethers";
import lodash from "lodash";
import { isPromiseFulfulled } from "./TypeGuards";

const defaultTimeout = 15 * 1000;

function delay(s: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, Math.round(s * 1000)));
}

function formatProviderError(provider: ethers.providers.JsonRpcProvider, rawErrorText: string) {
  return `Provider ${provider.connection.url} failed with error: ${rawErrorText}`;
}

class RetryProvider extends ethers.providers.JsonRpcProvider {
  readonly providers: ethers.providers.JsonRpcProvider[];
  constructor(
    params: ConstructorParameters<typeof ethers.providers.JsonRpcProvider>[],
    chainId: number,
    readonly nodeQuorumThreshold: number,
    readonly retries: number,
    readonly delay: number
  ) {
    // Initialize the super just with the chainId, which stops it from trying to immediately send out a .send before
    // this derived class is initialized.
    super(undefined, chainId);
    this.providers = params.map((inputs) => new ethers.providers.JsonRpcProvider(...inputs));
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
    const errors: [ethers.providers.JsonRpcProvider, string][] = [];

    // This function is used to try to send with a provider and if it fails pop an element off the fallback list to try
    // with that one. Once the fallback provider list is empty, the method throws. Because the fallback providers are
    // removed, we ensure that no provider is used more than once because we care about quorum, making sure all
    // considered responses come from unique providers.
    const tryWithFallback = (
      provider: ethers.providers.JsonRpcProvider
    ): Promise<[ethers.providers.JsonRpcProvider, any]> => {
      return this._trySend(provider, method, params)
        .then((result): [ethers.providers.JsonRpcProvider, any] => [provider, result])
        .catch((err) => {
          // Append the provider and error to the error array.
          errors.push([provider, err?.stack || err?.toString()]);

          // If there are no new fallback providers to use, terminate the recursion by throwing an error.
          // Otherwise, we can try to call another provider.
          if (fallbackProviders.length === 0) {
            throw new Error("Out of providers to fall back to.");
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
      throw new Error(
        `Not enough providers succeeded. Errors:\n${errorTexts.join("\n")}\n` +
          `Successful Providers:\n${successfulProviderUrls.join("\n")}`
      );
    }

    const values = results.map((result) => result.value);

    // Start at element 1 and begin comparing.
    // If _all_ values are equal, we have hit quorum, so return.
    if (values.slice(1).every(([, output]) => lodash.isEqual(values[0][1], output))) return values[0][1];

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
          .then((result): [ethers.providers.JsonRpcProvider, any] => [provider, result])
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
        const existingMatch = acc.find(([existingResult]) => lodash.isEqual(existingResult, result));

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

    return quorumResult;
  }

  _trySend(provider: ethers.providers.JsonRpcProvider, method: string, params: Array<any>): Promise<any> {
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

export function getProvider(chainId: number) {
  const { NODE_RETRIES, NODE_RETRY_DELAY, NODE_QUORUM, NODE_TIMEOUT } = process.env;

  const timeout = Number(process.env[`NODE_TIMEOUT_${chainId}`] || NODE_TIMEOUT || defaultTimeout);

  const constructorArgumentLists = getNodeUrlList(chainId).map(
    (nodeUrl): [{ url: string; timeout: number }, number] => [{ url: nodeUrl, timeout }, chainId]
  );

  // Default to 2 retries.
  const retries = Number(process.env[`NODE_RETRIES_${chainId}`] || NODE_RETRIES || "3");

  // Default to a delay of 1 second between retries.
  const retryDelay = Number(process.env[`NODE_RETRY_DELAY_${chainId}`] || NODE_RETRY_DELAY || "1");

  // Default to a node quorum of 1 node.
  const nodeQuorumThreshold = Number(process.env[`NODE_QUORUM_${chainId}`] || NODE_QUORUM || "1");

  return new RetryProvider(constructorArgumentLists, chainId, nodeQuorumThreshold, retries, retryDelay);
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

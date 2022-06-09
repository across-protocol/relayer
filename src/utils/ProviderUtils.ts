import { ethers, providers } from "ethers";
import deepEqual from "deep-equal";

const defaultTimeout = 15 * 1000;

function delay(s: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, Math.round(s * 1000)));
}

function isPromiseFulfulled<T>(
  promiseSettledResult: PromiseSettledResult<T>
): promiseSettledResult is PromiseFulfilledResult<T> {
  return promiseSettledResult.status === "fulfilled";
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
        `nodeQuorumThreshold cannot be < 1 and must be an integer. Currently set to ${this.nodeQuorumThreshold}`
      );
    if (this.retries < 0 || !Number.isInteger(this.retries))
      throw new Error(`retries cannot be < 0 and must be an integer. Currently set to ${this.retries}`);
    if (this.delay < 0) throw new Error(`delay cannot be < 0. Currently set to ${this.delay}`);
    if (this.nodeQuorumThreshold > this.providers.length)
      throw new Error(
        `nodeQuorumThreshold (${this.nodeQuorumThreshold}) must be <= the number of providers (${this.providers.length})`
      );
  }

  async send(method: string, params: Array<any>): Promise<any> {
    const requiredProviders = this.providers.slice(0, this.nodeQuorumThreshold);
    const fallbackProviders = this.providers.slice(this.nodeQuorumThreshold);
    const errors: [ethers.providers.JsonRpcProvider, string][] = [];

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
    if (values.slice(1).every(([, output]) => deepEqual(values[0][1], output))) return values[0][1];

    // Iteratively add results until we have enough matching to return.
    while (true) {
      // Grab a new result from our fallback providers.
      // If we run out of fallback providers, throw a useful error listing all of the successful and failed providers.
      const [provider, newOutput] = await tryWithFallback(fallbackProviders.shift()).catch(() => {
        const errorTexts = errors.map(([provider, errorText]) => formatProviderError(provider, errorText));
        const successfulProviderUrls = values.map(([provider]) => provider.connection.url);
        throw new Error(
          "Not enough providers agreed to meet quorum.\n" +
            "Providers that errored:\n" +
            `${errorTexts.join("\n")}\n` +
            "Providers that succeeded, but some failed to match:\n" +
            successfulProviderUrls.join("\n")
        );
      });

      // Filter only the elements that match the new element. If it meets quorum, return.
      const matchingElements = values.filter(([, output]) => deepEqual(output, newOutput));
      const totalMatching = matchingElements.length + 1;
      if (totalMatching >= this.nodeQuorumThreshold) return newOutput;

      // If we didn't return, append the new value to the array and loop back around.
      values.push([provider, newOutput]);
    }
  }

  _trySend(provider: ethers.providers.JsonRpcProvider, method: string, params: Array<any>): Promise<any> {
    let promise = provider.send(method, params);
    for (let i = 0; i < this.retries; i++) {
      promise = promise.catch(() => delay(this.delay).then(() => super.send(method, params)));
    }
    return promise;
  }
}

export function getProvider(chainId: number) {
  const { NODE_RETRIES, NODE_RETRY_DELAY, NODE_QUORUM, NODE_TIMEOUT } = process.env;

  const timeout = Number(process.env[`NODE_TIMEOUT_${chainId}`] || NODE_TIMEOUT || defaultTimeout);

  const constructorArgumentLists = getNodeUrlList(chainId).map(
    (nodeUrl): [{ url: string; timeout: number }, number] => [{ url: nodeUrl, timeout }, chainId]
  );

  // Default to 2 retries.
  const retries = Number(process.env[`NODE_RETRIES_${chainId}`] || NODE_RETRIES || "2");

  // Default to a delay of 1 second between retries.
  const retryDelay = Number(process.env[`NODE_RETRY_DELAY_${chainId}`] || NODE_RETRY_DELAY || "1");

  // Default to a node quorum of 1 node.
  const nodeQuorumThreshold = Number(process.env[`NODE_QUORUM_${chainId}`] || NODE_QUORUM || "1");

  return new RetryProvider(constructorArgumentLists, chainId, nodeQuorumThreshold, retries, retryDelay);
}

export function getNodeUrlList(chainId: number): string[] {
  const retryConfigKey = `RETRY_CONFIG_${chainId}`;
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

import assert from "assert";
import { providers as ethersProviders } from "ethers";
import { Provider as ZKSyncProvider } from "zksync-ethers";
import { RetryProvider } from "../ProviderUtils";
import { isDefined } from "../TypeGuards";

/**
 * Converts a valid Ethers Provider into a ZKSync Provider
 * @param ethersProvider The Ethers provider that we wish to convert
 * @returns A ZKSync Provider
 * @throws If the provider is not a valid JsonRpcProvider
 */
export function convertEthersRPCToZKSyncRPC(ethersProvider: ethersProviders.Provider): ZKSyncProvider {
  const url = (ethersProvider as RetryProvider).providers[0].connection.url;
  assert(isDefined(url), "Provider must be of type RetryProvider");
  return new ZKSyncProvider(url);
}

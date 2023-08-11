import { assert } from "chai";
import { Provider as ZKSyncProvider } from "zksync-web3";
import { isDefined } from "./TypeGuards";
import { RetryProvider } from "./ProviderUtils";

/**
 * Converts a valid Ethers Provider into a ZKSync Provider
 * @param ethersProvider The Ethers provider that we wish to convert
 * @returns A ZKSync Provider
 * @throws If the provider is not a valid JsonRpcProvider
 */
export function convertEthersRPCToZKSyncRPC(ethersProvider: RetryProvider): ZKSyncProvider {
  const url = (ethersProvider as RetryProvider).providers[0].connection.url;
  assert(isDefined(url), "Provider must be of type JsonRpcProvider");
  return new ZKSyncProvider(url);
}

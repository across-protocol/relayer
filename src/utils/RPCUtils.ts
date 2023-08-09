import { Provider } from "@ethersproject/abstract-provider";
import { assert } from "chai";
import { providers } from "ethers";
import { Provider as ZKSyncProvider } from "zksync-web3";
import { isDefined } from "./TypeGuards";

/**
 * Converts a valid Ethers Provider into a ZKSync Provider
 * @param ethersProvider The Ethers provider that we wish to convert
 * @returns A ZKSync Provider
 * @throws If the provider is not a valid JsonRpcProvider
 */
export function convertEthersRPCToZKSyncRPC(ethersProvider: Provider): ZKSyncProvider {
  const url = (ethersProvider as providers.JsonRpcProvider)?.connection?.url;
  assert(isDefined(url), "Provider must be of type JsonRpcProvider");
  return new ZKSyncProvider(url);
}

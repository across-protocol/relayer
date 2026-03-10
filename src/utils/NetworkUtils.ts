import assert from "assert";
import { Chain, extractChain } from "viem";
import * as viemChains from "viem/chains";
import { utils as sdkUtils } from "@across-protocol/sdk";

export const { getNetworkName, getNativeTokenSymbol } = sdkUtils;

type ViemChainId = (typeof viemChains)[keyof typeof viemChains]["id"];

const allViemChains = Object.values(viemChains);

function assertViemChainId(chainId: number): asserts chainId is ViemChainId {
  assert(
    allViemChains.some(({ id }) => id === chainId),
    `No viem chain definition for chain ID ${chainId}`
  );
}

/**
 * Resolve a viem Chain definition by chain ID.
 * @param chainId The numeric chain ID to look up.
 * @returns The matching viem Chain definition.
 * @throws If no viem chain definition exists for the given chain ID.
 */
export function getViemChain(chainId: number): Chain {
  assertViemChainId(chainId);
  return extractChain({ chains: allViemChains, id: chainId });
}

/**
 * Returns the origin of a URL.
 * @param url A URL.
 * @returns The origin of the URL, or "UNKNOWN" if the URL is invalid.
 */
export function getOriginFromURL(url: string): string {
  try {
    return new URL(url).origin;
  } catch (e) {
    return "UNKNOWN";
  }
}

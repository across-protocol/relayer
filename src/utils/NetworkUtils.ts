import { utils as sdkUtils } from "@across-protocol/sdk";
import { PUBLIC_NETWORKS } from "@across-protocol/constants";

export const { getNetworkName } = sdkUtils;

export function getNativeTokenSymbol(chainId: number | string): string {
  return PUBLIC_NETWORKS[chainId].nativeToken;
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

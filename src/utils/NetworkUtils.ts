import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import { ethers } from "ethers";

export const { getNetworkName } = sdkUtils;

export function getNativeTokenSymbol(chainId: number | string): string {
  if (chainId.toString() === "137" || chainId.toString() === "80001") {
    return "MATIC";
  }
  return "ETH";
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

export function getOriginUrlFromProvider(provider: ethers.providers.StaticJsonRpcProvider): string {
  return getOriginFromURL(provider.connection.url);
}

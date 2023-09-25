import { utils as sdkUtils } from "@across-protocol/sdk-v2";

export const { getNetworkName } = sdkUtils;

export function getNativeTokenSymbol(chainId: number | string): string {
  if (chainId.toString() === "137" || chainId.toString() === "80001") {
    return "MATIC";
  }
  return "ETH";
}

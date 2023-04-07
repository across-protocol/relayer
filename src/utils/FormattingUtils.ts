import { ethers, BigNumber } from "ethers";
import { utils } from "@across-protocol/sdk-v2";
import { createFormatFunction } from "../utils";

export type BigNumberish = utils.BigNumberish;
export type BN = utils.BN;

export const toWei = (num: BigNumberish): BN => ethers.utils.parseEther(num.toString());

export const toBNWei = utils.toBNWei;

export const toGWei = (num: BigNumberish): BN => ethers.utils.parseUnits(num.toString(), 9);

export const fromWei = utils.fromWei;

// @todo: Backport support for decimal points to @across-protocol/sdk-v2
export const toBN = (num: BigNumberish): BN => {
  // If the string version of the num contains a `.` then it is a number which needs to be parsed to a string int.
  if (num.toString().includes(".")) return BigNumber.from(parseInt(num.toString()));
  return BigNumber.from(num.toString());
};

export const formatFeePct = (relayerFeePct: BigNumber): string => {
  // 1e18 = 100% so 1e16 = 1%.
  return createFormatFunction(2, 4, false, 16)(toBN(relayerFeePct).toString());
};

export { createFormatFunction } from "@uma/common";

import { createEtherscanLinkMarkdown } from "@uma/common";

export function etherscanLink(txHashOrAddress: string, chainId: number | string): string {
  return createEtherscanLinkMarkdown(txHashOrAddress, Number(chainId));
}

export function etherscanLinks(txHashesOrAddresses: string[], chainId: number | string): string {
  return txHashesOrAddresses.map((hash) => `${etherscanLink(hash, chainId)}\n`).join("");
}

export const utf8ToHex = (input: string): string => ethers.utils.formatBytes32String(input);

export const hexToUtf8 = (input: string): string => ethers.utils.toUtf8String(input);

export const bnToHex = (input: BigNumber): string => ethers.utils.hexZeroPad(ethers.utils.hexlify(toBN(input)), 32);

export const convertFromWei = (weiVal: string, decimals: number): string => {
  const formatFunction = createFormatFunction(2, 4, false, decimals);
  return formatFunction(weiVal);
};

export const shortenHexStrings = (addresses: string[]): string[] => {
  return addresses.map((address) => shortenHexString(address));
};

export const shortenHexString = (hexString: string): string => {
  return hexString.substring(0, 10);
};

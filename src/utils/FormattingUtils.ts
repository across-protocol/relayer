import { ethers, BigNumber } from "ethers";
import { utils } from "@across-protocol/sdk-v2";
import { createFormatFunction } from "../utils";

export const toWei = (num: string | number | BigNumber) => ethers.utils.parseEther(num.toString());

export const toBNWei = utils.toBNWei;

export const toGWei = (num: string | number | BigNumber) => ethers.utils.parseUnits(num.toString(), 9);

export const fromWei = utils.fromWei;

export const toBN = utils.toBN;

export const formatFeePct = (relayerFeePct: BigNumber): string => {
  // 1e18 = 100% so 1e16 = 1%.
  return createFormatFunction(2, 4, false, 16)(toBN(relayerFeePct).toString());
};

export { createFormatFunction } from "@uma/common";

import { createEtherscanLinkMarkdown } from "@uma/common";

export const etherscanLink = (txHashOrAddress: string, chainId: number | string) =>
  createEtherscanLinkMarkdown(txHashOrAddress, Number(chainId));

export const etherscanLinks = (txHashesOrAddresses: string[], chainId: number | string) => {
  return txHashesOrAddresses.map((hash) => `${etherscanLink(hash, chainId)}\n`).join("");
};

export const utf8ToHex = (input: string) => ethers.utils.formatBytes32String(input);

export const hexToUtf8 = (input: string) => ethers.utils.toUtf8String(input);

export const bnToHex = (input: BigNumber) => ethers.utils.hexZeroPad(ethers.utils.hexlify(toBN(input)), 32);

export const convertFromWei = (weiVal: string, decimals: number) => {
  const formatFunction = createFormatFunction(2, 4, false, decimals);
  return formatFunction(weiVal);
};

export const shortenHexStrings = (addresses: string[]) => {
  return addresses.map((address) => shortenHexString(address));
};

export const shortenHexString = (hexString: string) => {
  return hexString.substring(0, 10);
};

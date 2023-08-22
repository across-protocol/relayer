import { ethers, BigNumber } from "ethers";
import { utils, constants } from "@across-protocol/sdk-v2";
import { createFormatFunction } from "@uma/common";

export { createFormatFunction };
export type BigNumberish = ethers.BigNumberish;
export type BN = ethers.BigNumber;

export const toWei = (num: BigNumberish): BN => ethers.utils.parseEther(num.toString());

export const toBNWei = utils.toBNWei;

export const toGWei = (num: BigNumberish): BN => ethers.utils.parseUnits(num.toString(), 9);

export const fromWei = utils.fromWei;

// @todo: Backport support for decimal points to @across-protocol/sdk-v2
export const toBN = (num: BigNumberish): BN => {
  // If the string version of the num contains a `.` then it is a number which needs to be parsed to a string int.
  if (num.toString().includes(".")) {
    return BigNumber.from(parseInt(num.toString()));
  }
  return BigNumber.from(num.toString());
};

export const formatFeePct = (relayerFeePct: BigNumber): string => {
  // 1e18 = 100% so 1e16 = 1%.
  return createFormatFunction(2, 4, false, 16)(toBN(relayerFeePct).toString());
};

export function etherscanLink(txHashOrAddress: string, chainId: number | string): string {
  return _createEtherscanLinkMarkdown(txHashOrAddress, Number(chainId));
}

// Generate an etherscan link prefix. If a networkId is provided then the URL will point to this network. Else, assume mainnet.
export function createEtherscanLinkFromTx(networkId: number): string {
  return constants.PUBLIC_NETWORKS[networkId]?.etherscan ?? "https://etherscan.io";
}

// Convert either an address or transaction to a shorter version.
// 0x772871a444c6e4e9903d8533a5a13101b74037158123e6709470f0afbf6e7d94 -> 0x7787...7d94
export function createShortHexString(hex: string): string {
  return hex.substring(0, 5) + "..." + hex.substring(hex.length - 6, hex.length);
}

// Take in either a transaction or an account and generate an etherscan link for the corresponding
// network formatted in markdown.
function _createEtherscanLinkMarkdown(hex: string, chainId = 1): string | null {
  if (hex.substring(0, 2) != "0x") {
    return null;
  }
  const shortURLString = createShortHexString(hex);
  // Transaction hash
  if (hex.length == 66) {
    return `<${createEtherscanLinkFromTx(chainId)}/tx/${hex}|${shortURLString}>`;
  }
  // Account
  else if (hex.length == 42) {
    return `<${createEtherscanLinkFromTx(chainId)}/address/${hex}|${shortURLString}>`;
  }
  return null;
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

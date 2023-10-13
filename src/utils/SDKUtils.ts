import { utils as sdkUtils } from "@across-protocol/sdk-v2";

export class BlockFinder extends sdkUtils.BlockFinder {};

export const {
  toBN,
  bnToHex,
  toWei,
  toBNWei,
  formatFeePct,
  shortenHexStrings,
  convertFromWei,
  max,
  min,
  utf8ToHex,
  createFormatFunction,
  fromWei,
  blockExplorerLink,
  blockExplorerLinks,
  createShortHexString: shortenHexString,
} = sdkUtils;

import * as sdk from "@across-protocol/sdk-v2";

export class BlockFinder extends sdk.utils.BlockFinder {}
export class PriceClient extends sdk.priceClient.PriceClient {}
export const { acrossApi, coingecko, defiLlama } = sdk.priceClient.adapters;

export const {
  bnZero,
  bnOne,
  bnUint32Max,
  bnUint256Max,
  fixedPointAdjustment,
  toBN,
  bnToHex,
  toWei,
  toGWei,
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
} = sdk.utils;

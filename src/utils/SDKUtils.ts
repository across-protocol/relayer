import * as sdk from "@across-protocol/sdk";

export class BlockFinder extends sdk.utils.BlockFinder {}
export type BlockFinderHints = sdk.utils.BlockFinderHints;

export class PriceClient extends sdk.priceClient.PriceClient {}
export const { acrossApi, coingecko, defiLlama } = sdk.priceClient.adapters;

export const {
  bnZero,
  bnOne,
  bnUint32Max,
  bnUint256Max,
  chainIsOPStack,
  chainIsArbitrum,
  chainIsProd,
  chainIsMatic,
  chainIsLinea,
  dedupArray,
  fillStatusArray,
  fixedPointAdjustment,
  forEachAsync,
  mapAsync,
  filterAsync,
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
  isContractDeployedToAddress,
  blockExplorerLinks,
  createShortHexString: shortenHexString,
} = sdk.utils;

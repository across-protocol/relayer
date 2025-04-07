import * as sdk from "@across-protocol/sdk";

export class BlockFinder extends sdk.utils.BlockFinder {}
export type BlockFinderHints = sdk.utils.BlockFinderHints;

export class AddressAggregator extends sdk.addressAggregator.AddressAggregator {}
export const addressAdapters = sdk.addressAggregator.adapters;

export class PriceClient extends sdk.priceClient.PriceClient {}
export const { acrossApi, coingecko, defiLlama } = sdk.priceClient.adapters;

export const { fillStatusArray, populateV3Relay, relayFillStatus } = sdk.arch.evm;

export const {
  assign,
  groupObjectCountsByProp,
  groupObjectCountsByTwoProps,
  groupObjectCountsByThreeProps,
  delay,
  getCurrentTime,
  averageBlockTime,
  bnZero,
  bnOne,
  bnUint32Max,
  bnUint256Max,
  chainIsOPStack,
  chainIsOrbit,
  chainIsArbitrum,
  chainIsProd,
  chainIsMatic,
  chainIsLinea,
  dedupArray,
  fixedPointAdjustment,
  forEachAsync,
  formatEther,
  formatUnits,
  mapAsync,
  parseUnits,
  filterAsync,
  toBN,
  bnToHex,
  toWei,
  toGWei,
  toBNWei,
  formatFeePct,
  shortenHexStrings,
  convertFromWei,
  formatGwei,
  max,
  min,
  utf8ToHex,
  createFormatFunction,
  fromWei,
  blockExplorerLink,
  isContractDeployedToAddress,
  blockExplorerLinks,
  createShortHexString: shortenHexString,
  compareAddressesSimple,
  getTokenInfo,
  getL1TokenInfo,
  getUsdcSymbol,
  Profiler,
  getMessageHash,
  getRelayEventKey,
  toBytes32,
  validateFillForDeposit,
} = sdk.utils;

export const {
  getRefundsFromBundle,
  isChainDisabled,
  getWidestPossibleExpectedBlockRange,
  getEndBlockBuffers,
  buildPoolRebalanceLeafTree,
  getNetSendAmountForL1Token,
  _buildPoolRebalanceRoot,
} = sdk.clients.BundleDataClient;

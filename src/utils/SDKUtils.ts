import * as sdk from "@across-protocol/sdk";

// EVMBlockFinder returns _only_ EVMBlock types.
export class EVMBlockFinder extends sdk.arch.evm.EVMBlockFinder {}
export type BlockFinderHints = sdk.utils.BlockFinderHints;

export class AddressAggregator extends sdk.addressAggregator.AddressAggregator {}
export const addressAdapters = sdk.addressAggregator.adapters;

export class PriceClient extends sdk.priceClient.PriceClient {}
export const { acrossApi, coingecko, defiLlama } = sdk.priceClient.adapters;

export class Address extends sdk.utils.Address {}
export class EvmAddress extends sdk.utils.EvmAddress {}
export class SvmAddress extends sdk.utils.SvmAddress {}

export type EvmGasPriceEstimate = sdk.gasPriceOracle.EvmGasPriceEstimate;

export type SVMProvider = sdk.arch.svm.SVMProvider;
export const { fillStatusArray, populateV3Relay, relayFillStatus, getTimestampForBlock } = sdk.arch.evm;

export const {
  assign,
  groupObjectCountsByProp,
  groupObjectCountsByTwoProps,
  groupObjectCountsByThreeProps,
  delay,
  getCurrentTime,
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
  getL1TokenAddress,
  getUsdcSymbol,
  Profiler,
  getMessageHash,
  getRelayEventKey,
  toBytes32,
  validateFillForDeposit,
  toAddressType,
  chainIsEvm,
  ConvertDecimals,
  getTokenInfo,
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

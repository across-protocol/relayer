import * as sdk from "@across-protocol/sdk";

// EVMBlockFinder returns _only_ EVMBlock types.
export class EVMBlockFinder extends sdk.arch.evm.EVMBlockFinder {}
export class SVMBlockFinder extends sdk.arch.svm.SVMBlockFinder {}
export type BlockFinderHints = sdk.utils.BlockFinderHints;

export class AddressAggregator extends sdk.addressAggregator.AddressAggregator {}
export const addressAdapters = sdk.addressAggregator.adapters;

export class SvmCpiEventsClient extends sdk.arch.svm.SvmCpiEventsClient {}

export class PriceClient extends sdk.priceClient.PriceClient {}
export const { acrossApi, coingecko, defiLlama } = sdk.priceClient.adapters;
export const { isEVMSpokePoolClient, isSVMSpokePoolClient } = sdk.clients;

export class Address extends sdk.utils.Address {}
export class EvmAddress extends sdk.utils.EvmAddress {}
export class SvmAddress extends sdk.utils.SvmAddress {}

export type EvmGasPriceEstimate = sdk.gasPriceOracle.EvmGasPriceEstimate;

export const { fillStatusArray, populateV3Relay, relayFillStatus, getTimestampForBlock, averageBlockTime } =
  sdk.arch.evm;
export const {
  getAssociatedTokenAddress,
  toAddress: toKitAddress,
  getStatePda,
  getFillStatusPda,
  getRelayDataHash,
  getInstructionParamsPda,
  getRootBundlePda,
  getTransferLiabilityPda,
  getEventAuthority,
  getClaimAccountPda,
  createDefaultTransaction,
} = sdk.arch.svm;
export type SVMProvider = sdk.arch.svm.SVMProvider;

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
  compareAddresses,
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
  chainIsSvm,
  ConvertDecimals,
  getTokenInfo,
  convertRelayDataParamsToBytes32,
  convertFillParamsToBytes32,
  getRandomInt,
  randomAddress,
  convertRelayDataParamsToNative,
  convertFillParamsToNative,
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

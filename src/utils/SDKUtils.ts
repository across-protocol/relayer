import * as sdk from "@across-protocol/sdk";
import type { PopulatedTransaction } from "ethers";
import type { TronWeb } from "tronweb";

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
export class TvmAddress extends sdk.utils.TvmAddress {}

export type EvmGasPriceEstimate = sdk.gasPriceOracle.EvmGasPriceEstimate;

export const {
  fillStatusArray,
  findDepositBlock,
  populateV3Relay,
  relayFillStatus,
  getTimestampForBlock,
  averageBlockTime,
} = sdk.arch.evm;
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
  getCCTPDepositAccounts,
} = sdk.arch.svm;
export async function submitTransactionTvm(
  tronWeb: TronWeb,
  populatedTx: PopulatedTransaction,
  feeLimit: number,
  callValue = 0,
  onSubmission?: (transactionHash?: string) => void | Promise<void>
): Promise<{ txid: string; result: boolean }> {
  if (!onSubmission) {
    return sdk.arch.tvm.submitTransaction(tronWeb, populatedTx, feeLimit, callValue);
  }
  const { to, data } = populatedTx;
  if (!to) {
    throw new Error("submitTransaction: populatedTx must have a 'to' field");
  }
  const recipient = TvmAddress.from(to).toNative();
  const owner = tronWeb.defaultAddress?.base58;
  if (!owner) {
    throw new Error("submitTransaction: TronWeb instance must have a default address configured");
  }
  let unsignedTransaction;
  if (!sdk.utils.isDefined(data)) {
    if (callValue <= 0) {
      throw new Error("submitTransaction: a transaction with no calldata must transfer a non-zero value");
    }
    unsignedTransaction = await tronWeb.transactionBuilder.sendTrx(recipient, callValue, owner);
  } else {
    const transaction = await tronWeb.transactionBuilder.triggerSmartContract(
      recipient,
      "",
      { feeLimit, input: data.startsWith("0x") ? data.slice(2) : data, callValue },
      [],
      owner
    );
    if (!transaction?.result?.result) {
      throw new Error(
        `submitTransaction: triggerSmartContract failed: ${transaction?.result?.message ?? "Unknown error"}`
      );
    }
    unsignedTransaction = transaction.transaction;
  }
  const signed = await tronWeb.trx.sign(unsignedTransaction);
  await onSubmission(signed.txID);
  const broadcast = await tronWeb.trx.sendRawTransaction(signed);
  return { txid: broadcast.txid ?? signed.txID, result: broadcast.result ?? false };
}
export type SVMProvider = sdk.arch.svm.SVMProvider;
export type LatestBlockhash = sdk.arch.svm.LatestBlockhash;
export type SolanaTransaction = sdk.arch.svm.SolanaTransaction;

export const {
  assign,
  groupObjectCountsByProp,
  groupObjectCountsByTwoProps,
  groupObjectCountsByThreeProps,
  delay,
  retry,
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
  isUnsafeDepositId,
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
  createShortenedString: shortenHexString,
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
  chunk,
  chainIsL1,
  unpackDepositEvent,
  unpackFillEvent,
  chainHasNativeToken,
  chainIsTvm,
  fetchWithTimeout,
  postWithTimeout,
  isHttpError,
  HttpError,
} = sdk.utils;

export type FetchHeaders = sdk.utils.FetchHeaders;
export type FetchQueryParams = sdk.utils.FetchQueryParams;

export const {
  getRefundsFromBundle,
  isChainDisabledAtBlock,
  getWidestPossibleExpectedBlockRange,
  getEndBlockBuffers,
  buildPoolRebalanceLeafTree,
  getNetSendAmountForL1Token,
  _buildPoolRebalanceRoot,
} = sdk.clients.BundleDataClient;

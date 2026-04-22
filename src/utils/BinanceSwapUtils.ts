import assert from "assert";
import { OrderType_LT, Symbol } from "binance-api-node";
import { CONTRACT_ADDRESSES } from "../common";
import { BigNumber } from "./BNUtils";
import { BINANCE_WITHDRAWAL_STATUS, resolveBinanceCoinSymbol } from "./BinanceUtils";
import { fromWei, toBNWei } from "./SDKUtils";
import { isDefined } from "./TypeGuards";

export interface BinanceSpotMarketMeta {
  symbol: string;
  baseAssetName: string;
  quoteAssetName: string;
  pxDecimals: number;
  szDecimals: number;
  minimumOrderSize: number;
  isBuy: boolean;
}

export function isFailedBinanceWithdrawal(status?: number): boolean {
  switch (status) {
    case BINANCE_WITHDRAWAL_STATUS.CANCELLED:
    case BINANCE_WITHDRAWAL_STATUS.REJECTED:
    case BINANCE_WITHDRAWAL_STATUS.FAILURE:
      return true;
    default:
      return false;
  }
}

export function isTerminalBinanceWithdrawal(status?: number): boolean {
  switch (status) {
    case BINANCE_WITHDRAWAL_STATUS.CANCELLED:
    case BINANCE_WITHDRAWAL_STATUS.REJECTED:
    case BINANCE_WITHDRAWAL_STATUS.FAILURE:
    case BINANCE_WITHDRAWAL_STATUS.COMPLETED:
      return true;
    default:
      return false;
  }
}

export function isSameBinanceCoin(sourceToken: string, destinationToken: string): boolean {
  return resolveBinanceCoinSymbol(sourceToken) === resolveBinanceCoinSymbol(destinationToken);
}

export function supportsBinanceIntermediateBridgeToken(token: string): boolean {
  return token === "USDC" || token === "USDT";
}

export function getAtomicDepositorContracts(chainId: number):
  | {
      atomicDepositorAddress: string;
      atomicDepositorAbi: unknown[];
      transferProxyAddress: string;
      transferProxyAbi: unknown[];
    }
  | undefined {
  const chainContracts = CONTRACT_ADDRESSES[chainId];
  const atomicDepositorAddress = chainContracts?.atomicDepositor?.address;
  const atomicDepositorAbi = chainContracts?.atomicDepositor?.abi;
  const transferProxyAddress = chainContracts?.atomicDepositorTransferProxy?.address;
  const transferProxyAbi = chainContracts?.atomicDepositorTransferProxy?.abi;

  if (
    !isDefined(atomicDepositorAddress) ||
    !isDefined(atomicDepositorAbi) ||
    !isDefined(transferProxyAddress) ||
    !isDefined(transferProxyAbi)
  ) {
    return undefined;
  }

  return {
    atomicDepositorAddress,
    atomicDepositorAbi,
    transferProxyAddress,
    transferProxyAbi,
  };
}

export function usesBinanceAtomicDepositorTransfer(token: string, chainId: number): boolean {
  return token === "WETH" && isDefined(getAtomicDepositorContracts(chainId));
}

export function deriveBinanceSpotMarketMeta(
  sourceToken: string,
  destinationToken: string,
  symbol: Symbol<OrderType_LT>
): BinanceSpotMarketMeta {
  const sourceAsset = resolveBinanceCoinSymbol(sourceToken);
  const destinationAsset = resolveBinanceCoinSymbol(destinationToken);
  const isBuy = symbol.baseAsset === destinationAsset && symbol.quoteAsset === sourceAsset;
  const isSell = symbol.baseAsset === sourceAsset && symbol.quoteAsset === destinationAsset;
  assert(isBuy || isSell, `No spot market meta found for route: ${sourceToken}-${destinationToken}`);

  const priceFilter = symbol.filters.find((filter) => filter.filterType === "PRICE_FILTER");
  const sizeFilter = symbol.filters.find((filter) => filter.filterType === "LOT_SIZE");
  assert(isDefined(priceFilter?.tickSize), `PRICE_FILTER missing tickSize for ${symbol.symbol}`);
  assert(isDefined(sizeFilter?.stepSize) && isDefined(sizeFilter?.minQty), `LOT_SIZE missing for ${symbol.symbol}`);

  return {
    symbol: symbol.symbol,
    baseAssetName: symbol.baseAsset,
    quoteAssetName: symbol.quoteAsset,
    pxDecimals: resolveStepPrecision(priceFilter.tickSize),
    szDecimals: resolveStepPrecision(sizeFilter.stepSize),
    minimumOrderSize: Number(sizeFilter.minQty),
    isBuy,
  };
}

export function convertBinanceRouteAmount(params: {
  amount: BigNumber;
  sourceTokenDecimals: number;
  destinationTokenDecimals: number;
  isBuy: boolean;
  price: number;
  direction: "source-to-destination" | "destination-to-source";
}): BigNumber {
  const isSourceToDestination = params.direction === "source-to-destination";
  const inputDecimals = isSourceToDestination ? params.sourceTokenDecimals : params.destinationTokenDecimals;
  const outputDecimals = isSourceToDestination ? params.destinationTokenDecimals : params.sourceTokenDecimals;
  const readableAmount = Number(fromWei(params.amount, inputDecimals));
  const convertedAmount = isSourceToDestination
    ? params.isBuy
      ? readableAmount / params.price
      : readableAmount * params.price
    : params.isBuy
      ? readableAmount * params.price
      : readableAmount / params.price;

  return toBNWei(truncate(convertedAmount, outputDecimals), outputDecimals);
}

function resolveStepPrecision(stepSize: string): number {
  const normalized = stepSize.replace(/0+$/, "").replace(/\.$/, "");
  const decimalPart = normalized.split(".")[1];
  return decimalPart?.length ?? 0;
}

function truncate(value: number, decimals: number): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  const factor = 10 ** decimals;
  return Math.trunc(value * factor) / factor;
}

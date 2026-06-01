import { BinanceStablecoinSwapAdapter } from "../../rebalancer/adapters/binance";
import { BigNumber, assert, formatUnits, getTokenInfoFromSymbol, isDefined, toBNWei, truncate } from "../../utils";
import {
  EDGE_CLASS_INPUT_USD_SAMPLES,
  EDGE_CLASS_RATE_SEGMENT_THRESHOLD_BPS,
  UNIVERSAL_INPUT_TIER_USD,
} from "../constants";
import type { RuntimePricingContext } from "./PricingContext";
import type {
  BinanceInternalAdapter,
  EdgePricingParams,
  GraphEdgeCandidate,
  HyperliquidInternalAdapter,
  JussiEdgeClassDefinition,
  JussiEdgeClassOutputSegmentDefinition,
  JussiRateDefinition,
  LogicalAsset,
} from "../types";
import { resolveEdgeClassId, resolveRateLimitBucketId } from "../topology/edges";
import { quoteLiveOftRouteTransfer } from "./quotes";

export async function serializeEdgeClassDefinition(
  candidate: GraphEdgeCandidate,
  params: Pick<EdgePricingParams, "baseSigner" | "pricingContext" | "rebalancerAdapters">
): Promise<JussiEdgeClassDefinition> {
  const edge_class_id = resolveEdgeClassId(candidate);
  return {
    edge_class_id,
    venue: candidate.family,
    input_logical_asset: candidate.from.logicalAsset,
    output_logical_asset: candidate.to.logicalAsset,
    output: {
      segments: await resolveOutputSegments(candidate, params),
    },
    ...(resolveRateLimitBucketId(candidate.family)
      ? { rate_limit_bucket_id: resolveRateLimitBucketId(candidate.family) }
      : {}),
  };
}

async function resolveOutputSegments(
  candidate: GraphEdgeCandidate,
  params: Pick<EdgePricingParams, "baseSigner" | "pricingContext" | "rebalancerAdapters">
): Promise<JussiEdgeClassOutputSegmentDefinition[]> {
  if (candidate.family === "oft") {
    return estimateSampledOutputSegments(candidate, params, estimateOftMarginalOutputRateAtUsd);
  }

  if (
    candidate.family === "cctp" ||
    candidate.family === "canonical" ||
    candidate.family === "bridgeapi" ||
    candidate.family === "hyperlane" ||
    candidate.family === "binance_cex_bridge" ||
    candidate.from.logicalAsset === candidate.to.logicalAsset
  ) {
    return [{ up_to_input_usd: UNIVERSAL_INPUT_TIER_USD, marginal_output_rate: { numerator: "1", denominator: "1" } }];
  }

  if (candidate.family === "hyperliquid") {
    return estimateSampledOutputSegments(candidate, params, estimateHyperliquidMarginalOutputRateAtUsd);
  }

  if (candidate.family === "binance") {
    return estimateSampledOutputSegments(candidate, params, estimateBinanceMarginalOutputRateAtUsd);
  }

  return [{ up_to_input_usd: UNIVERSAL_INPUT_TIER_USD, marginal_output_rate: { numerator: "1", denominator: "1" } }];
}

async function estimateSampledOutputSegments(
  candidate: GraphEdgeCandidate,
  params: Pick<EdgePricingParams, "baseSigner" | "pricingContext" | "rebalancerAdapters">,
  estimateRateAtUsd: (
    candidate: GraphEdgeCandidate,
    inputUsd: number,
    params: Pick<EdgePricingParams, "baseSigner" | "pricingContext" | "rebalancerAdapters">
  ) => Promise<JussiRateDefinition>
): Promise<JussiEdgeClassOutputSegmentDefinition[]> {
  const samples = await Promise.all(
    EDGE_CLASS_INPUT_USD_SAMPLES.map(async (inputUsd) => ({
      inputUsd,
      rate: await estimateRateAtUsd(candidate, inputUsd, params),
    }))
  );

  const significantSamples: typeof samples = [samples[0]];
  for (const sample of samples.slice(1)) {
    if (
      rateDistanceBps(sample.rate, significantSamples[significantSamples.length - 1].rate) >=
      EDGE_CLASS_RATE_SEGMENT_THRESHOLD_BPS
    ) {
      significantSamples.push(sample);
    }
  }

  if (significantSamples.length === 1) {
    const worstRate = samples.reduce(
      (currentWorst, sample) => minRateDefinition(currentWorst, sample.rate),
      samples[0].rate
    );
    return [{ up_to_input_usd: UNIVERSAL_INPUT_TIER_USD, marginal_output_rate: worstRate }];
  }

  return significantSamples.map((sample, index) => ({
    up_to_input_usd:
      index === significantSamples.length - 1
        ? UNIVERSAL_INPUT_TIER_USD
        : formatInputUsdTier(significantSamples[index + 1].inputUsd),
    marginal_output_rate: sample.rate,
  }));
}

async function estimateBinanceMarginalOutputRateAtUsd(
  candidate: GraphEdgeCandidate,
  inputUsd: number,
  params: Pick<EdgePricingParams, "pricingContext" | "rebalancerAdapters">
): Promise<JussiRateDefinition> {
  assert(isDefined(candidate.rebalanceRoute), "Binance edge class estimation requires rebalance route metadata");
  const { sourceToken, destinationToken } = candidate.rebalanceRoute;
  const [forwardRate, reverseRate] = await Promise.all([
    estimateDirectionalBinanceMarginalOutputRate(
      sourceToken as LogicalAsset,
      destinationToken as LogicalAsset,
      inputUsd,
      params
    ),
    estimateDirectionalBinanceMarginalOutputRate(
      destinationToken as LogicalAsset,
      sourceToken as LogicalAsset,
      inputUsd,
      params
    ),
  ]);

  return minRateDefinition(forwardRate, reverseRate);
}

async function estimateDirectionalBinanceMarginalOutputRate(
  sourceToken: LogicalAsset,
  destinationToken: LogicalAsset,
  inputUsd: number,
  params: Pick<EdgePricingParams, "pricingContext" | "rebalancerAdapters">
): Promise<JussiRateDefinition> {
  if (sourceToken === destinationToken) {
    return { numerator: "1", denominator: "1" };
  }

  const { hubPoolChainId } = params.pricingContext;
  const adapter = params.rebalancerAdapters.binance as BinanceStablecoinSwapAdapter;
  const adapterInternals = adapter as unknown as BinanceInternalAdapter;
  const sourceTokenInfo = getTokenInfoFromSymbol(sourceToken, hubPoolChainId);
  const destinationTokenInfo = getTokenInfoFromSymbol(destinationToken, hubPoolChainId);
  const referenceInputNative = await resolveUsdNotionalInputNative(
    sourceToken,
    sourceTokenInfo.decimals,
    inputUsd,
    params.pricingContext
  );
  const marketMeta = await adapterInternals._getSpotMarketMetaForRoute(sourceToken, destinationToken);
  const estimatedOutputNative = await adapterInternals._convertSourceToDestination(
    sourceToken,
    hubPoolChainId,
    destinationToken,
    hubPoolChainId,
    referenceInputNative
  );
  const takerCommissionPct =
    Number((await adapterInternals._getTradeFees()).find((fee) => fee.symbol === marketMeta.symbol)?.takerCommission) ||
    0;
  const feeFactor = Math.max(0, 1 - takerCommissionPct / 100);
  const netOutputReadable = parseFloat(formatUnits(estimatedOutputNative, destinationTokenInfo.decimals)) * feeFactor;
  const referenceOutputReadable = await quoteReferenceOutputReadable(
    sourceToken,
    destinationToken,
    referenceInputNative,
    sourceTokenInfo.decimals,
    params.pricingContext
  );
  return decimalToRate(netOutputReadable / Math.max(referenceOutputReadable, Number.EPSILON));
}

async function estimateHyperliquidMarginalOutputRateAtUsd(
  candidate: GraphEdgeCandidate,
  inputUsd: number,
  params: Pick<EdgePricingParams, "pricingContext" | "rebalancerAdapters">
): Promise<JussiRateDefinition> {
  assert(isDefined(candidate.rebalanceRoute), "Hyperliquid edge class estimation requires rebalance route metadata");
  const { sourceToken, destinationToken } = candidate.rebalanceRoute;
  const [forwardRate, reverseRate] = await Promise.all([
    estimateDirectionalHyperliquidMarginalOutputRate(
      sourceToken as LogicalAsset,
      destinationToken as LogicalAsset,
      inputUsd,
      params
    ),
    estimateDirectionalHyperliquidMarginalOutputRate(
      destinationToken as LogicalAsset,
      sourceToken as LogicalAsset,
      inputUsd,
      params
    ),
  ]);

  return minRateDefinition(forwardRate, reverseRate);
}

async function estimateDirectionalHyperliquidMarginalOutputRate(
  sourceToken: LogicalAsset,
  destinationToken: LogicalAsset,
  inputUsd: number,
  params: Pick<EdgePricingParams, "pricingContext" | "rebalancerAdapters">
): Promise<JussiRateDefinition> {
  if (sourceToken === destinationToken) {
    return { numerator: "1", denominator: "1" };
  }

  const { hubPoolChainId } = params.pricingContext;
  const adapter = params.rebalancerAdapters.hyperliquid;
  const adapterInternals = adapter as unknown as HyperliquidInternalAdapter;
  const sourceTokenInfo = getTokenInfoFromSymbol(sourceToken, hubPoolChainId);
  const destinationTokenInfo = getTokenInfoFromSymbol(destinationToken, hubPoolChainId);
  const referenceInputNative = await resolveUsdNotionalInputNative(
    sourceToken,
    sourceTokenInfo.decimals,
    inputUsd,
    params.pricingContext
  );
  const { px } = await adapterInternals._getLatestPrice(
    sourceToken,
    destinationToken,
    hubPoolChainId,
    referenceInputNative,
    1.0
  );
  const spotMarketMeta = adapterInternals._getSpotMarketMetaForRoute(sourceToken, destinationToken);
  const sourceReadable = parseFloat(formatUnits(referenceInputNative, sourceTokenInfo.decimals));
  const executionPrice = Number(px);
  const grossOutputReadable = spotMarketMeta.isBuy ? sourceReadable / executionPrice : sourceReadable * executionPrice;
  const takerFeePct = Number(formatUnits(await adapterInternals._getUserTakerFeePct(), 18));
  const feeFactor = Math.max(0, 1 - takerFeePct / 100);
  const netOutputReadable = parseFloat(
    truncate(grossOutputReadable * feeFactor, destinationTokenInfo.decimals).toString()
  );
  const referenceOutputReadable = await quoteReferenceOutputReadable(
    sourceToken,
    destinationToken,
    referenceInputNative,
    sourceTokenInfo.decimals,
    params.pricingContext
  );
  return decimalToRate(netOutputReadable / Math.max(referenceOutputReadable, Number.EPSILON));
}

async function estimateOftMarginalOutputRateAtUsd(
  candidate: GraphEdgeCandidate,
  inputUsd: number,
  params: Pick<EdgePricingParams, "baseSigner" | "pricingContext">
): Promise<JussiRateDefinition> {
  const referenceInputNative = await resolveUsdNotionalInputNative(
    candidate.from.logicalAsset,
    candidate.from.decimals,
    inputUsd,
    params.pricingContext
  );
  const quote = await quoteLiveOftRouteTransfer(
    candidate,
    referenceInputNative,
    params.baseSigner,
    params.pricingContext.hubPoolChainId
  );
  const outputReadable = parseFloat(formatUnits(quote.amountReceivedDestinationNative, candidate.to.decimals));
  const referenceOutputReadable = await quoteReferenceOutputReadable(
    candidate.from.logicalAsset,
    candidate.to.logicalAsset,
    quote.roundedInputSourceNative,
    candidate.from.decimals,
    params.pricingContext
  );
  return decimalToRate(outputReadable / Math.max(referenceOutputReadable, Number.EPSILON));
}

export async function resolveUsdNotionalInputNative(
  logicalAsset: LogicalAsset,
  sourceDecimals: number,
  inputUsd: number,
  pricingContext: RuntimePricingContext
): Promise<BigNumber> {
  const assetPriceUsd = await pricingContext.getLogicalAssetPriceUsd(logicalAsset);
  const inputAmount = inputUsd / Math.max(assetPriceUsd, Number.EPSILON);
  return toBNWei(truncate(inputAmount, sourceDecimals).toString(), sourceDecimals);
}

async function quoteReferenceOutputReadable(
  inputLogicalAsset: LogicalAsset,
  outputLogicalAsset: LogicalAsset,
  inputNative: BigNumber,
  inputDecimals: number,
  pricingContext: RuntimePricingContext
): Promise<number> {
  const inputReadable = parseFloat(formatUnits(inputNative, inputDecimals));
  if (inputLogicalAsset === outputLogicalAsset) {
    return inputReadable;
  }
  const [inputPriceUsd, outputPriceUsd] = await Promise.all([
    pricingContext.getLogicalAssetPriceUsd(inputLogicalAsset),
    pricingContext.getLogicalAssetPriceUsd(outputLogicalAsset),
  ]);
  return (inputReadable * inputPriceUsd) / Math.max(outputPriceUsd, Number.EPSILON);
}

function decimalToRate(value: number): JussiRateDefinition {
  const denominator = 1_000_000;
  const clamped = Math.max(0, Math.min(1, value));
  return {
    numerator: Math.round(clamped * denominator).toString(),
    denominator: denominator.toString(),
  };
}

function minRateDefinition(left: JussiRateDefinition, right: JussiRateDefinition): JussiRateDefinition {
  return rateToDecimal(left) <= rateToDecimal(right) ? left : right;
}

function rateToDecimal(rate: JussiRateDefinition): number {
  return Number(rate.numerator) / Math.max(Number(rate.denominator), Number.EPSILON);
}

function rateDistanceBps(left: JussiRateDefinition, right: JussiRateDefinition): number {
  return Math.abs(rateToDecimal(left) - rateToDecimal(right)) * 10_000;
}

function formatInputUsdTier(value: number): string {
  return value.toFixed(6);
}

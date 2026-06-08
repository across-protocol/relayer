import {
  CANONICAL_BRIDGE,
  CANONICAL_L2_BRIDGE,
  CCTP_MAX_SEND_AMOUNT,
  CUSTOM_BRIDGE,
  CUSTOM_L2_BRIDGE,
} from "../../common";
import { BinanceStablecoinSwapAdapter } from "../../rebalancer/adapters/binance";
import {
  BINANCE_NETWORKS,
  BigNumber,
  CHAIN_IDs,
  ConvertDecimals,
  EvmAddress,
  TOKEN_SYMBOLS_MAP,
  assert,
  bnZero,
  chainIsSvm,
  getProvider,
  getTokenInfoFromSymbol,
  isDefined,
  toAddressType,
  toBNWei,
  truncate,
} from "../../utils";
import { EDGE_FIXED_COST_INPUT_USD_SAMPLE, LATENCY_BY_FAMILY, UNIVERSAL_INPUT_TIER_USD } from "../constants";
import type { RuntimePricingContext } from "./PricingContext";
import type {
  BinanceInternalAdapter,
  BridgeBreakdownParams,
  CostBreakdown,
  EdgeEconomics,
  EdgeFamily,
  EdgePricingParams,
  ExchangeBreakdownParams,
  ExchangeBreakdownState,
  GraphEdgeCandidate,
  JussiEdgeDefinition,
  LogicalAsset,
  ManagedNodeContext,
} from "../types";
import { resolveSerializedEdgeId } from "../topology/edges";
import {
  resolveBridgeLatencySeconds,
  resolveExchangeLatencySeconds,
  resolveGraphBridgeLatencySeconds,
} from "../topology/latency";
import { canonicalNodeKey } from "../topology/nodes";
import { quoteLiveOftRouteTransfer } from "./quotes";
import { resolveUsdNotionalInputNative } from "./rates";

export function serializeEdgeDefinition(
  candidate: GraphEdgeCandidate,
  economics: EdgeEconomics,
  edgeClassId: string
): JussiEdgeDefinition {
  return {
    edge_id: resolveSerializedEdgeId(candidate, edgeClassId),
    edge_class_id: edgeClassId,
    from_node_key: candidate.from.nodeKey,
    to_node_key: candidate.to.nodeKey,
    input_capacity_native: economics.inputCapacityNative.toString(),
    cost: {
      fixed_input_fee_native: economics.fixedInputFeeNative.toString(),
      fixed_output_fee_native: economics.fixedOutputFeeNative.toString(),
      fixed_cost_native: economics.fixedCostNative.toString(),
    },
    latency_seconds: economics.latencySeconds,
  };
}

export async function estimateEdgeEconomics(
  candidate: GraphEdgeCandidate,
  params: EdgePricingParams
): Promise<EdgeEconomics> {
  const inputCapacityNative = await resolveInputCapacityNative(candidate, params);
  const costReferenceInputNative = await resolveCostReferenceInputNative(candidate, params, inputCapacityNative);
  let breakdown: CostBreakdown;

  switch (candidate.family) {
    case "binance":
      breakdown = await estimateBinanceSwapBreakdown(candidate, costReferenceInputNative, params);
      break;
    case "hyperliquid":
      breakdown = await estimateHyperliquidSwapBreakdown(candidate, costReferenceInputNative, params);
      break;
    case "cctp":
      breakdown = await estimateCctpBreakdown(candidate, costReferenceInputNative, params);
      break;
    case "oft":
      breakdown = await estimateOftBreakdown(candidate, costReferenceInputNative, params);
      break;
    case "binance_cex_bridge":
      breakdown = await estimateBinanceCexBridgeBreakdown(candidate, params);
      break;
    case "bridgeapi":
      breakdown = await estimateBridgeApiBreakdown(candidate, params);
      break;
    case "hyperlane":
      breakdown = await estimateQuotedBridgeBreakdown(candidate, costReferenceInputNative, params, "hyperlane");
      break;
    case "canonical":
      breakdown = await estimateQuotedBridgeBreakdown(candidate, costReferenceInputNative, params, "canonical");
      break;
  }

  return {
    inputCapacityNative,
    fixedInputFeeNative: minBigNumber(breakdown.fixedInputFeeSourceNative, inputCapacityNative),
    fixedOutputFeeNative: breakdown.fixedOutputFeeDestinationNative,
    fixedCostNative: await params.pricingContext.usdToNativeValue(breakdown.fixedCostUsd, candidate.from.chainId),
    latencySeconds: breakdown.latencySeconds,
  };
}

async function resolveInputCapacityNative(
  candidate: GraphEdgeCandidate,
  params: Pick<EdgePricingParams, "pricingContext" | "rebalancerAdapters" | "cumulativeBalancesByLogicalAsset">
): Promise<BigNumber> {
  if (candidate.family === "cctp") {
    return CCTP_MAX_SEND_AMOUNT;
  }

  const effectivelyUnlimitedCapacityNative = await resolveEffectivelyUnlimitedCapacityNative(
    candidate.from.logicalAsset,
    candidate.from.decimals,
    params.pricingContext
  );

  if (candidate.family === "binance") {
    return resolveBinanceSwapInputCapacityNative(candidate, params, effectivelyUnlimitedCapacityNative);
  }

  if (candidate.family === "binance_cex_bridge") {
    return resolveBinanceCexBridgeInputCapacityNative(candidate, params, effectivelyUnlimitedCapacityNative);
  }

  return effectivelyUnlimitedCapacityNative;
}

async function resolveCostReferenceInputNative(
  candidate: GraphEdgeCandidate,
  params: Pick<EdgePricingParams, "pricingContext">,
  inputCapacityNative: BigNumber
): Promise<BigNumber> {
  if (candidate.family === "cctp" || candidate.family === "binance_cex_bridge" || candidate.family === "bridgeapi") {
    return inputCapacityNative;
  }

  const sampledInputNative = await resolveUsdNotionalInputNative(
    candidate.from.logicalAsset,
    candidate.from.decimals,
    EDGE_FIXED_COST_INPUT_USD_SAMPLE,
    params.pricingContext
  );
  return minBigNumber(sampledInputNative, inputCapacityNative);
}

async function resolveEffectivelyUnlimitedCapacityNative(
  logicalAsset: LogicalAsset,
  decimals: number,
  pricingContext: RuntimePricingContext
): Promise<BigNumber> {
  return resolveUsdNotionalInputNative(logicalAsset, decimals, Number(UNIVERSAL_INPUT_TIER_USD), pricingContext);
}

async function resolveBinanceSwapInputCapacityNative(
  candidate: GraphEdgeCandidate,
  params: Pick<EdgePricingParams, "pricingContext" | "rebalancerAdapters">,
  inputCapacityNative: BigNumber
): Promise<BigNumber> {
  assert(isDefined(candidate.rebalanceRoute), "Binance swap edge is missing rebalance route");
  const adapter = params.rebalancerAdapters.binance as BinanceStablecoinSwapAdapter;
  // See BinanceInternalAdapter in ../types: this cast reaches private adapter methods unchecked.
  const adapterInternals = adapter as unknown as BinanceInternalAdapter;
  const { sourceToken, destinationToken, sourceChain, destinationChain } = candidate.rebalanceRoute;
  let capacityNative = inputCapacityNative;

  const sourceEntrypointNetwork = await adapterInternals._getEntrypointNetwork(sourceChain, sourceToken);
  if (sourceToken === "USDC" && sourceEntrypointNetwork !== sourceChain) {
    capacityNative = minBigNumber(capacityNative, resolveCctpMaxSendAmountNative(candidate.from.decimals));
  }

  const destinationEntrypointNetwork = await adapterInternals._getEntrypointNetwork(destinationChain, destinationToken);
  const destinationTokenInfo = getTokenInfoFromSymbol(destinationToken, destinationEntrypointNetwork);
  const destinationAmountLimitNative = await resolveBinanceWithdrawalAmountLimitNative(
    adapterInternals,
    destinationToken,
    destinationEntrypointNetwork,
    destinationTokenInfo.decimals
  );
  const destinationBridgeLimitNative =
    destinationToken === "USDC" && destinationEntrypointNetwork !== destinationChain
      ? resolveCctpMaxSendAmountNative(destinationTokenInfo.decimals)
      : undefined;
  const destinationLimitNative = minOptionalBigNumbers(destinationAmountLimitNative, destinationBridgeLimitNative);

  if (!isDefined(destinationLimitNative)) {
    return capacityNative;
  }

  const sampledInputNative = minBigNumber(
    await resolveUsdNotionalInputNative(
      candidate.from.logicalAsset,
      candidate.from.decimals,
      EDGE_FIXED_COST_INPUT_USD_SAMPLE,
      params.pricingContext
    ),
    capacityNative
  );
  if (sampledInputNative.isZero()) {
    return capacityNative;
  }
  const estimatedOutputAtSampleNative = await adapterInternals._convertSourceToDestination(
    sourceToken,
    sourceChain,
    destinationToken,
    destinationEntrypointNetwork,
    sampledInputNative
  );
  if (estimatedOutputAtSampleNative.isZero()) {
    return capacityNative;
  }

  return minBigNumber(
    capacityNative,
    sampledInputNative.mul(destinationLimitNative).div(estimatedOutputAtSampleNative)
  );
}

async function resolveBinanceCexBridgeInputCapacityNative(
  candidate: GraphEdgeCandidate,
  params: Pick<EdgePricingParams, "pricingContext" | "rebalancerAdapters">,
  inputCapacityNative: BigNumber
): Promise<BigNumber> {
  const adapter = params.rebalancerAdapters.binance as BinanceStablecoinSwapAdapter;
  // See BinanceInternalAdapter in ../types: this cast reaches private adapter methods unchecked.
  const adapterInternals = adapter as unknown as BinanceInternalAdapter;
  const tokenSymbol = candidate.from.logicalAsset;
  const network =
    BINANCE_NETWORKS[candidate.to.chainId] ??
    BINANCE_NETWORKS[candidate.from.chainId] ??
    BINANCE_NETWORKS[params.pricingContext.hubPoolChainId];
  const coin = await adapterInternals._getAccountCoins(tokenSymbol);
  const withdrawFeeConfig = coin.networkList.find((entry) => entry.name === network);
  assert(
    isDefined(withdrawFeeConfig),
    `Withdraw fee config not found for ${tokenSymbol} on Binance network ${network}`
  );
  const withdrawMaxNative = resolvePositiveBinanceAmountNative(withdrawFeeConfig.withdrawMax, candidate.from.decimals);
  return isDefined(withdrawMaxNative) ? minBigNumber(inputCapacityNative, withdrawMaxNative) : inputCapacityNative;
}

async function resolveBinanceWithdrawalAmountLimitNative(
  adapterInternals: BinanceInternalAdapter,
  token: string,
  chainId: number,
  decimals: number
): Promise<BigNumber | undefined> {
  const coin = await adapterInternals._getAccountCoins(token);
  const network = BINANCE_NETWORKS[chainId];
  const withdrawNetworkConfig = coin.networkList.find((entry) => entry.name === network);
  assert(isDefined(withdrawNetworkConfig), `No Binance network entry for ${token} on chain ${chainId}`);
  return resolvePositiveBinanceAmountNative(withdrawNetworkConfig.withdrawMax, decimals);
}

function resolvePositiveBinanceAmountNative(value: string | undefined, decimals: number): BigNumber | undefined {
  if (!isDefined(value)) {
    return undefined;
  }
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return undefined;
  }
  return toBNWei(truncate(numericValue, decimals), decimals);
}

function resolveCctpMaxSendAmountNative(decimals: number): BigNumber {
  return ConvertDecimals(TOKEN_SYMBOLS_MAP.USDC.decimals, decimals)(CCTP_MAX_SEND_AMOUNT);
}

function minOptionalBigNumbers(...values: Array<BigNumber | undefined>): BigNumber | undefined {
  return values.reduce<BigNumber | undefined>((minimum, value) => {
    if (!isDefined(value)) {
      return minimum;
    }
    return isDefined(minimum) ? minBigNumber(minimum, value) : value;
  }, undefined);
}

async function estimateCctpBreakdown(
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  params: BridgeBreakdownParams
): Promise<CostBreakdown> {
  const [gasCostUsd, maxFeeSourceNative] = await Promise.all([
    params.pricingContext.deriveGasCostUsd(candidate.family, candidate.from.chainId),
    resolveCctpMaxFeeSourceNative(candidate, amount, params),
  ]);
  return {
    fixedInputFeeSourceNative: maxFeeSourceNative,
    fixedOutputFeeDestinationNative: bnZero,
    fixedCostUsd: gasCostUsd,
    latencySeconds: resolveGraphBridgeLatencySeconds(candidate, params.pricingContext.hubPoolChainId),
  };
}

async function resolveCctpMaxFeeSourceNative(
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  params: BridgeBreakdownParams
): Promise<BigNumber> {
  const cctpAdapter = params.rebalancerAdapters.cctp;
  assert(isDefined(cctpAdapter), "CCTP fee estimation requires the cctp rebalancer adapter");
  const rebalanceRoute = candidate.rebalanceRoute ?? {
    sourceChain: candidate.from.chainId,
    sourceToken: candidate.from.logicalAsset,
    destinationChain: candidate.to.chainId,
    destinationToken: candidate.to.logicalAsset,
    adapter: "cctp",
  };
  assert(
    rebalanceRoute.sourceToken === "USDC" &&
      rebalanceRoute.destinationToken === "USDC" &&
      rebalanceRoute.adapter === "cctp",
    `Unsupported CCTP fee route ${rebalanceRoute.sourceToken} -> ${rebalanceRoute.destinationToken} via ${rebalanceRoute.adapter}`
  );
  return cctpAdapter.getEstimatedCost(rebalanceRoute, amount, false);
}

async function estimateOftBreakdown(
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  params: BridgeBreakdownParams
): Promise<CostBreakdown> {
  const [gasCostUsd, oftRouteQuote] = await Promise.all([
    params.pricingContext.deriveGasCostUsd(candidate.family, candidate.from.chainId),
    quoteLiveOftRouteTransfer(candidate, amount, params.baseSigner, params.pricingContext.hubPoolChainId),
  ]);
  assert(
    oftRouteQuote.messageFeeIsNative || isDefined(oftRouteQuote.messageFeeAssetAddress),
    `Missing OFT fee asset metadata for ${candidate.from.chainId} -> ${candidate.to.chainId}`
  );
  let quotedMessageFeeUsd: number;
  if (oftRouteQuote.messageFeeIsNative) {
    quotedMessageFeeUsd = await params.pricingContext.nativeValueToUsd(
      oftRouteQuote.messageFeeAmount,
      candidate.from.chainId
    );
  } else {
    assert(
      isDefined(oftRouteQuote.messageFeeAssetAddress),
      `Missing OFT fee asset metadata for ${candidate.from.chainId} -> ${candidate.to.chainId}`
    );
    quotedMessageFeeUsd = await params.pricingContext.tokenValueToUsd(
      oftRouteQuote.messageFeeAmount,
      candidate.from.chainId,
      oftRouteQuote.messageFeeAssetAddress
    );
  }

  return {
    fixedInputFeeSourceNative: bnZero,
    fixedOutputFeeDestinationNative: bnZero,
    fixedCostUsd: gasCostUsd + quotedMessageFeeUsd,
    latencySeconds: resolveBridgeLatencySeconds("oft", candidate.from.chainId, candidate.from.logicalAsset),
  };
}

async function estimateBridgeRouteBreakdown(
  token: LogicalAsset,
  sourceChain: number,
  destinationChain: number,
  amount: BigNumber,
  params: BridgeBreakdownParams
): Promise<CostBreakdown> {
  const syntheticCandidate = buildSyntheticBridgeCandidate(token, sourceChain, destinationChain);
  if (token === "USDC") {
    return estimateCctpBreakdown(syntheticCandidate, amount, params);
  }
  if (token === "USDT") {
    return estimateOftBreakdown(syntheticCandidate, amount, params);
  }
  throw new Error(`Unsupported intermediate bridge token for exchange route: ${token}`);
}

async function estimateBinanceSwapBreakdown(
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  params: ExchangeBreakdownParams
): Promise<CostBreakdown> {
  assert(isDefined(candidate.rebalanceRoute), "Binance swap edge is missing rebalance route");
  const adapter = params.rebalancerAdapters.binance as BinanceStablecoinSwapAdapter;
  // See BinanceInternalAdapter in ../types: this cast reaches private adapter methods unchecked.
  const adapterInternals = adapter as unknown as BinanceInternalAdapter;
  const { sourceToken, destinationToken, sourceChain, destinationChain } = candidate.rebalanceRoute;
  const destinationCoin = await adapterInternals._getAccountCoins(destinationToken);
  const destinationEntrypointNetwork = await adapterInternals._getEntrypointNetwork(destinationChain, destinationToken);
  const destinationTokenInfo = getTokenInfoFromSymbol(destinationToken, destinationEntrypointNetwork);
  const withdrawNetwork = BINANCE_NETWORKS[destinationEntrypointNetwork];
  const withdrawNetworkConfig = destinationCoin.networkList.find(
    (network: { name: string }) => network.name === withdrawNetwork
  );
  assert(
    isDefined(withdrawNetworkConfig),
    `No Binance network entry for ${destinationToken} on chain ${destinationEntrypointNetwork}`
  );
  const withdrawFee = toBNWei(withdrawNetworkConfig.withdrawFee, destinationTokenInfo.decimals);
  const state = await initializeExchangeBreakdown(candidate, params.pricingContext);
  state.fixedOutputFeeDestinationNative = ConvertDecimals(
    destinationTokenInfo.decimals,
    candidate.to.decimals
  )(withdrawFee);

  const sourceEntrypointNetwork = await adapterInternals._getEntrypointNetwork(sourceChain, sourceToken);
  if (sourceEntrypointNetwork !== sourceChain) {
    await addBridgeLegToExchangeBreakdown(state, candidate, amount, params, {
      side: "source",
      token: sourceToken as LogicalAsset,
      sourceChain,
      destinationChain: sourceEntrypointNetwork,
      sourceDecimals: candidate.from.decimals,
    });
  }

  if (destinationEntrypointNetwork !== destinationChain) {
    const destinationBridgeAmount = await adapterInternals._convertSourceToDestination(
      sourceToken,
      sourceChain,
      destinationToken,
      destinationEntrypointNetwork,
      amount
    );
    await addBridgeLegToExchangeBreakdown(state, candidate, destinationBridgeAmount, params, {
      side: "destination",
      token: destinationToken as LogicalAsset,
      sourceChain: destinationEntrypointNetwork,
      destinationChain,
      sourceDecimals: getTokenInfoFromSymbol(destinationToken, destinationEntrypointNetwork).decimals,
    });
  }
  return finalizeExchangeBreakdown(state, "binance");
}

async function estimateHyperliquidSwapBreakdown(
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  params: ExchangeBreakdownParams
): Promise<CostBreakdown> {
  assert(isDefined(candidate.rebalanceRoute), "Hyperliquid swap edge is missing rebalance route");
  const { sourceToken, destinationToken, sourceChain, destinationChain } = candidate.rebalanceRoute;
  const state = await initializeExchangeBreakdown(candidate, params.pricingContext);

  if (sourceChain !== CHAIN_IDs.HYPEREVM) {
    await addBridgeLegToExchangeBreakdown(state, candidate, amount, params, {
      side: "source",
      token: sourceToken as LogicalAsset,
      sourceChain,
      destinationChain: CHAIN_IDs.HYPEREVM,
      sourceDecimals: candidate.from.decimals,
    });
  }

  if (destinationChain !== CHAIN_IDs.HYPEREVM) {
    await addBridgeLegToExchangeBreakdown(state, candidate, amount, params, {
      side: "destination",
      token: destinationToken as LogicalAsset,
      sourceChain: CHAIN_IDs.HYPEREVM,
      destinationChain,
      sourceDecimals: getTokenInfoFromSymbol(destinationToken, CHAIN_IDs.HYPEREVM).decimals,
    });
  }
  return finalizeExchangeBreakdown(state, "hyperliquid");
}

async function estimateBinanceCexBridgeBreakdown(
  candidate: GraphEdgeCandidate,
  params: Pick<BridgeBreakdownParams, "pricingContext" | "rebalancerAdapters">
): Promise<CostBreakdown> {
  const adapter = params.rebalancerAdapters.binance as BinanceStablecoinSwapAdapter;
  // See BinanceInternalAdapter in ../types: this cast reaches private adapter methods unchecked.
  const adapterInternals = adapter as unknown as BinanceInternalAdapter;
  const tokenSymbol = candidate.from.logicalAsset;
  const network =
    BINANCE_NETWORKS[candidate.to.chainId] ??
    BINANCE_NETWORKS[candidate.from.chainId] ??
    BINANCE_NETWORKS[params.pricingContext.hubPoolChainId];
  const coin = await adapterInternals._getAccountCoins(tokenSymbol);
  const withdrawFeeConfig = coin.networkList.find((entry) => entry.name === network);
  assert(
    isDefined(withdrawFeeConfig),
    `Withdraw fee config not found for ${tokenSymbol} on Binance network ${network}`
  );

  return {
    fixedInputFeeSourceNative: bnZero,
    fixedOutputFeeDestinationNative: toBNWei(withdrawFeeConfig.withdrawFee, candidate.to.decimals),
    fixedCostUsd: await params.pricingContext.deriveGasCostUsd(candidate.family, candidate.from.chainId),
    latencySeconds: resolveGraphBridgeLatencySeconds(candidate, params.pricingContext.hubPoolChainId),
  };
}

async function estimateBridgeApiBreakdown(
  candidate: GraphEdgeCandidate,
  params: Pick<BridgeBreakdownParams, "pricingContext">
): Promise<CostBreakdown> {
  return {
    fixedInputFeeSourceNative: bnZero,
    fixedOutputFeeDestinationNative: bnZero,
    fixedCostUsd: await params.pricingContext.deriveGasCostUsd(candidate.family, candidate.from.chainId),
    latencySeconds: LATENCY_BY_FAMILY.bridgeapi,
  };
}

export async function estimateQuotedBridgeBreakdown(
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  params: Pick<BridgeBreakdownParams, "baseSigner" | "pricingContext">,
  family: EdgeFamily,
  quoteBridgeFeeUsd: typeof quoteNativeBridgeFeeUsd = quoteNativeBridgeFeeUsd
): Promise<CostBreakdown> {
  const quotedFeeUsd = await quoteBridgeFeeUsd(candidate, amount, params);
  const gasCostUsd = await params.pricingContext.deriveGasCostUsd(family, candidate.from.chainId);
  return {
    fixedInputFeeSourceNative: bnZero,
    fixedOutputFeeDestinationNative: bnZero,
    fixedCostUsd: quotedFeeUsd + gasCostUsd,
    latencySeconds: resolveGraphBridgeLatencySeconds(candidate, params.pricingContext.hubPoolChainId),
  };
}

function buildSyntheticBridgeCandidate(
  logicalAsset: LogicalAsset,
  sourceChain: number,
  destinationChain: number
): GraphEdgeCandidate {
  const family = logicalAsset === "USDC" ? "cctp" : logicalAsset === "USDT" ? "oft" : undefined;
  assert(isDefined(family), `Synthetic bridge candidate not supported for ${logicalAsset}`);
  return {
    family,
    adapterOrBridgeName: family,
    from: buildSyntheticBridgeNode(logicalAsset, sourceChain),
    to: buildSyntheticBridgeNode(logicalAsset, destinationChain),
  } as GraphEdgeCandidate;
}

function buildSyntheticBridgeNode(logicalAsset: LogicalAsset, chainId: number): ManagedNodeContext {
  const tokenInfo = getTokenInfoFromSymbol(logicalAsset, chainId);
  return {
    chainId,
    tokenAddress: tokenInfo.address.toNative(),
    symbol: tokenInfo.symbol,
    nodeKey: canonicalNodeKey(chainId, tokenInfo.address.toNative()),
    decimals: tokenInfo.decimals,
    logicalAsset,
  } as ManagedNodeContext;
}

function minBigNumber(a: BigNumber, b: BigNumber): BigNumber {
  return a.lte(b) ? a : b;
}

async function initializeExchangeBreakdown(
  candidate: GraphEdgeCandidate,
  pricingContext: RuntimePricingContext
): Promise<ExchangeBreakdownState> {
  return {
    fixedInputFeeSourceNative: bnZero,
    fixedOutputFeeDestinationNative: bnZero,
    fixedCostUsd: await pricingContext.deriveGasCostUsd(candidate.family, candidate.from.chainId),
    sourceBridgeLatencySeconds: 0,
    destinationBridgeLatencySeconds: 0,
  };
}

async function addBridgeLegToExchangeBreakdown(
  state: ExchangeBreakdownState,
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  params: BridgeBreakdownParams,
  leg: {
    side: "source" | "destination";
    token: LogicalAsset;
    sourceChain: number;
    destinationChain: number;
    sourceDecimals: number;
  }
): Promise<void> {
  const bridgeBreakdown = await estimateBridgeRouteBreakdown(
    leg.token,
    leg.sourceChain,
    leg.destinationChain,
    amount,
    params
  );
  if (leg.side === "source") {
    state.fixedInputFeeSourceNative = state.fixedInputFeeSourceNative.add(bridgeBreakdown.fixedInputFeeSourceNative);
  } else {
    const fixedInputFeeAsOutputNative = ConvertDecimals(
      leg.sourceDecimals,
      candidate.to.decimals
    )(bridgeBreakdown.fixedInputFeeSourceNative);
    state.fixedOutputFeeDestinationNative = state.fixedOutputFeeDestinationNative
      .add(fixedInputFeeAsOutputNative)
      .add(ConvertDecimals(leg.sourceDecimals, candidate.to.decimals)(bridgeBreakdown.fixedOutputFeeDestinationNative));
  }
  state.fixedCostUsd += bridgeBreakdown.fixedCostUsd;
  if (leg.side === "source") {
    state.sourceBridgeLatencySeconds = bridgeBreakdown.latencySeconds;
  } else {
    state.destinationBridgeLatencySeconds = bridgeBreakdown.latencySeconds;
  }
}

function finalizeExchangeBreakdown(
  state: ExchangeBreakdownState,
  family: Extract<EdgeFamily, "binance" | "hyperliquid">
): CostBreakdown {
  return {
    fixedInputFeeSourceNative: state.fixedInputFeeSourceNative,
    fixedOutputFeeDestinationNative: state.fixedOutputFeeDestinationNative,
    fixedCostUsd: state.fixedCostUsd,
    latencySeconds: resolveExchangeLatencySeconds({
      family,
      sourceBridgeLatencySeconds: state.sourceBridgeLatencySeconds,
      destinationBridgeLatencySeconds: state.destinationBridgeLatencySeconds,
    }),
  };
}

async function quoteNativeBridgeFeeUsd(
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  params: Pick<BridgeBreakdownParams, "baseSigner" | "pricingContext">
): Promise<number> {
  const { hubPoolChainId } = params.pricingContext;
  const l1Token = EvmAddress.from(TOKEN_SYMBOLS_MAP[candidate.from.logicalAsset].addresses[hubPoolChainId]);
  if (candidate.to.chainId === hubPoolChainId) {
    const constructor =
      CUSTOM_L2_BRIDGE[candidate.from.chainId]?.[l1Token.toNative()] ?? CANONICAL_L2_BRIDGE[candidate.from.chainId];
    if (!isDefined(constructor)) {
      return 0;
    }
    const l2Provider = await getProvider(candidate.from.chainId);
    const l2SignerOrProvider = chainIsSvm(candidate.from.chainId) ? l2Provider : params.baseSigner.connect(l2Provider);
    const l1Signer = params.baseSigner.connect(await getProvider(hubPoolChainId));
    const bridge = new constructor(candidate.from.chainId, hubPoolChainId, l2SignerOrProvider, l1Signer, l1Token);
    const txns = await bridge.constructWithdrawToL1Txns(
      EvmAddress.from(await params.baseSigner.getAddress()),
      toAddressType(candidate.from.tokenAddress, candidate.from.chainId),
      l1Token,
      amount
    );
    let totalUsd = 0;
    for (const txn of txns as { value?: BigNumber; chainId?: number }[]) {
      totalUsd += await params.pricingContext.nativeValueToUsd(
        txn.value ?? bnZero,
        txn.chainId ?? candidate.from.chainId
      );
    }
    return totalUsd;
  }

  const constructor =
    CUSTOM_BRIDGE[candidate.to.chainId]?.[l1Token.toNative()] ?? CANONICAL_BRIDGE[candidate.to.chainId];
  if (!isDefined(constructor)) {
    return 0;
  }
  const l1Signer = params.baseSigner.connect(await getProvider(hubPoolChainId));
  const l2Provider = await getProvider(candidate.to.chainId);
  const bridge = new constructor(
    candidate.to.chainId,
    hubPoolChainId,
    l1Signer,
    l2Provider,
    l1Token,
    params.pricingContext.logger
  );
  const txn = await bridge.constructL1ToL2Txn(
    EvmAddress.from(await params.baseSigner.getAddress()),
    l1Token,
    toAddressType(candidate.to.tokenAddress, candidate.to.chainId),
    amount
  );
  return params.pricingContext.nativeValueToUsd(txn.value ?? bnZero, hubPoolChainId);
}

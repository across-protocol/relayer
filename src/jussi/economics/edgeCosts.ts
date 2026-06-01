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
} from "../../utils";
import { LATENCY_BY_FAMILY, UNIVERSAL_INPUT_TIER_USD } from "../constants";
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
  const referenceInputNative = await resolveInputCapacityNative(candidate, params);
  let breakdown: CostBreakdown;

  switch (candidate.family) {
    case "binance":
      breakdown = await estimateBinanceSwapBreakdown(candidate, referenceInputNative, params);
      break;
    case "hyperliquid":
      breakdown = await estimateHyperliquidSwapBreakdown(candidate, referenceInputNative, params);
      break;
    case "cctp":
      breakdown = await estimateCctpBreakdown(candidate, referenceInputNative, params);
      break;
    case "oft":
      breakdown = await estimateOftBreakdown(candidate, referenceInputNative, params);
      break;
    case "binance_cex_bridge":
      breakdown = await estimateBinanceCexBridgeBreakdown(candidate, params);
      break;
    case "bridgeapi":
      breakdown = await estimateBridgeApiBreakdown(candidate, params);
      break;
    case "hyperlane":
      breakdown = await estimateQuotedBridgeBreakdown(candidate, referenceInputNative, params, "hyperlane");
      break;
    case "canonical":
      breakdown = await estimateQuotedBridgeBreakdown(candidate, referenceInputNative, params, "canonical");
      break;
  }

  return {
    inputCapacityNative: referenceInputNative,
    fixedInputFeeNative: minBigNumber(breakdown.fixedInputFeeSourceNative, referenceInputNative),
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

  return resolveEffectivelyUnlimitedCapacityNative(
    candidate.from.logicalAsset,
    candidate.from.decimals,
    params.pricingContext
  );
}

async function resolveEffectivelyUnlimitedCapacityNative(
  logicalAsset: LogicalAsset,
  decimals: number,
  pricingContext: RuntimePricingContext
): Promise<BigNumber> {
  return resolveUsdNotionalInputNative(logicalAsset, decimals, Number(UNIVERSAL_INPUT_TIER_USD), pricingContext);
}

async function estimateCctpBreakdown(
  candidate: GraphEdgeCandidate,
  _amount: BigNumber,
  params: BridgeBreakdownParams
): Promise<CostBreakdown> {
  return {
    fixedInputFeeSourceNative: bnZero,
    fixedOutputFeeDestinationNative: bnZero,
    fixedCostUsd: await params.pricingContext.deriveGasCostUsd(candidate.family, candidate.from.chainId),
    latencySeconds: resolveGraphBridgeLatencySeconds(candidate, params.pricingContext.hubPoolChainId),
  };
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
  const adapterInternals = adapter as unknown as BinanceInternalAdapter;
  const { sourceToken, destinationToken, sourceChain, destinationChain } = candidate.rebalanceRoute;
  const destinationCoin = await adapterInternals._getAccountCoins(destinationToken);
  const destinationEntrypointNetwork = await adapterInternals._getEntrypointNetwork(destinationChain, destinationToken);
  const destinationTokenInfo = getTokenInfoFromSymbol(destinationToken, destinationEntrypointNetwork);
  const withdrawNetwork = BINANCE_NETWORKS[destinationEntrypointNetwork];
  const withdrawNetworkConfig =
    destinationCoin.networkList.find((network: { name: string }) => network.name === withdrawNetwork) ??
    destinationCoin.networkList[0];
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
    await addBridgeLegToExchangeBreakdown(state, candidate, amount, params, {
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

async function estimateQuotedBridgeBreakdown(
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  params: Pick<BridgeBreakdownParams, "baseSigner" | "pricingContext">,
  family: EdgeFamily
): Promise<CostBreakdown> {
  const quotedFeeUsd = await quoteNativeBridgeFeeUsd(candidate, amount, params);
  return {
    fixedInputFeeSourceNative: bnZero,
    fixedOutputFeeDestinationNative: bnZero,
    fixedCostUsd: Math.max(quotedFeeUsd, await params.pricingContext.deriveGasCostUsd(family, candidate.from.chainId)),
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
    state.fixedOutputFeeDestinationNative = state.fixedOutputFeeDestinationNative.add(
      ConvertDecimals(leg.sourceDecimals, candidate.to.decimals)(bridgeBreakdown.fixedOutputFeeDestinationNative)
    );
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

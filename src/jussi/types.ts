import type { InventoryClient } from "../clients";
import type { TokenBalanceConfig } from "../interfaces/InventoryManagement";
import type { RelayerConfig } from "../relayer/RelayerConfig";
import type { RebalanceRoute, RebalancerAdapter } from "../rebalancer/utils/interfaces";
import type { RebalancerConfig } from "../rebalancer/RebalancerConfig";
import type { RuntimePricingContext } from "./economics/PricingContext";
import type { BigNumber, MessagingFeeStruct, SendParamStruct, Signer, winston } from "../utils";

export type JussiRateDefinition = { numerator: string; denominator: string };
export type JussiLogicalAssetDefinition = {
  decimals_by_chain: Record<string, number>;
  native_price_alias_chain_ids?: string[];
};
export type JussiEdgeClassOutputSegmentDefinition = {
  up_to_input_usd: string;
  marginal_output_rate: JussiRateDefinition;
};
export type JussiRateLimitBucketCostSegmentDefinition = {
  up_to_usage_usd: string;
  marginal_cost_per_unit_usd: string;
};
export type JussiRateLimitBucketDefinition = {
  bucket_id: string;
  capacity_usd: string;
  window_seconds: number;
  cost_usd: { segments: JussiRateLimitBucketCostSegmentDefinition[] };
};
export type JussiEdgeClassDefinition = {
  edge_class_id: string;
  venue: string;
  input_logical_asset: string;
  output_logical_asset: string;
  output: { segments: JussiEdgeClassOutputSegmentDefinition[] };
  rate_limit_bucket_id?: string;
};
export type JussiNodeDefinition = {
  node_key: string;
  chain_id: number;
  token_address: string;
  symbol: string;
  logical_asset: string;
  decimals: number;
  target_allocation_ratio: string;
  min_allocation_ratio: string;
  max_allocation_ratio: string;
  shortage_cost_usd_per_unit_time?: string;
  surplus_cost_usd_per_unit_time?: string;
};
export type JussiCumulativeBalancePainDefinition = {
  target_balance_native: string;
  min_threshold_native: string;
  max_threshold_native: string;
  surplus_annualized_cost_rate: string;
  deficit_annualized_cost_rate: string;
  out_of_band_severity_multiplier: string;
};
export type JussiEdgeDefinition = {
  edge_id: string;
  edge_class_id: string;
  from_node_key: string;
  to_node_key: string;
  input_capacity_native: string;
  cost: { fixed_input_fee_native: string; fixed_output_fee_native: string; fixed_cost_native: string };
  latency_seconds?: number;
};
export type JussiPainModel = {
  surplus_annualized_cost_rate: string;
  deficit_annualized_cost_rate: string;
  out_of_band_severity_multiplier: string;
};
export type JussiPutGraphRequest = {
  latency_annualized_cost_rate: string;
  pain_model: JussiPainModel;
  logical_assets: Record<string, JussiLogicalAssetDefinition>;
  cumulative_balance_pain: Record<string, JussiCumulativeBalancePainDefinition>;
  edge_classes: JussiEdgeClassDefinition[];
  nodes: JussiNodeDefinition[];
  edges: JussiEdgeDefinition[];
};
export type JussiPutGraphBundleRequest = {
  graph: JussiPutGraphRequest;
  rate_limit_buckets: JussiRateLimitBucketDefinition[];
};
export type JussiRateLimitBucketsJson = {
  rate_limit_buckets: JussiRateLimitBucketDefinition[];
};
export type BuiltJussiGraph = {
  graphId: string;
  payload: JussiPutGraphRequest;
  rate_limit_buckets: JussiRateLimitBucketDefinition[];
  gasPriceDiagnostics?: JussiGasPriceDiagnostic[];
};
export type JussiGasPriceDiagnostic = {
  chainId: number;
  gasPriceWei: string;
  gasPriceGwei: string;
  source: "72h_avg" | "fallback_current_oracle";
};

export type LogicalAsset = "USDC" | "USDT" | "WETH";
export type StableLogicalAsset = Exclude<LogicalAsset, "WETH">;
export type JussiGraphEnvelope = { graph_id: string; payload: JussiPutGraphBundleRequest };
export type JussiGraphJson = JussiPutGraphRequest;
export type JussiGraphBundleJson = JussiPutGraphBundleRequest;
export type JussiGraphRateLimitBucketsJson = JussiRateLimitBucketsJson;
export type EdgeFamily =
  | "binance"
  | "binance_cex_bridge"
  | "bridgeapi"
  | "canonical"
  | "cctp"
  | "hyperlane"
  | "hyperliquid"
  | "oft";

// prettier-ignore
export type ManagedNodeTemplate = { chainId: number; tokenAddress: string; symbol: string; logicalAsset: LogicalAsset; decimals: number; tokenConfig?: TokenBalanceConfig; managed: boolean };
export type ManagedNodeContext = ManagedNodeTemplate & { nodeKey: string; definition: JussiNodeDefinition };
export type ManagedNodeRatios = {
  targetAllocationRatio: BigNumber;
  minAllocationRatio: BigNumber;
  maxAllocationRatio: BigNumber;
};
// prettier-ignore
export type GraphEdgeCandidate = { family: EdgeFamily; adapterOrBridgeName: string; effectiveBridgeName?: string; from: ManagedNodeContext; to: ManagedNodeContext; rebalanceRoute?: RebalanceRoute };
// prettier-ignore
export type EdgeEconomics = {
  inputCapacityNative: BigNumber;
  fixedInputFeeNative: BigNumber;
  fixedOutputFeeNative: BigNumber;
  fixedCostNative: BigNumber;
  latencySeconds: number;
};
export type CostBreakdown = {
  fixedInputFeeSourceNative: BigNumber;
  fixedOutputFeeDestinationNative: BigNumber;
  fixedCostUsd: number;
  latencySeconds: number;
};
export type ResolvedGasPrice = {
  gasPriceWei: BigNumber;
  source: "72h_avg" | "fallback_current_oracle";
};
export type OftQuoteReader = {
  sharedDecimals(): Promise<number>;
  quoteOFT(
    sendParamStruct: SendParamStruct
  ): Promise<[unknown, Array<{ feeAmountLD: BigNumber | string; description: string }>, { amountReceivedLD: string }]>;
  quoteSend(sendParamStruct: SendParamStruct, payInLzToken: boolean): Promise<MessagingFeeStruct>;
};
export type OftRouteTransferQuote = {
  roundedInputSourceNative: BigNumber;
  amountReceivedDestinationNative: BigNumber;
  messageFeeAssetAddress?: string;
  messageFeeAmount: BigNumber;
  messageFeeIsNative: boolean;
  sendParamStruct: SendParamStruct;
};
// prettier-ignore
export type BridgeBreakdownParams = {
  logger: winston.Logger;
  baseSigner: Signer;
  pricingContext: RuntimePricingContext;
  rebalancerAdapters: Record<string, RebalancerAdapter>;
};
export type ExchangeBreakdownParams = BridgeBreakdownParams;
export type EdgePricingParams = ExchangeBreakdownParams & {
  cumulativeBalancesByLogicalAsset: Record<LogicalAsset, BigNumber>;
};

export type ExchangeBreakdownState = {
  fixedInputFeeSourceNative: BigNumber;
  fixedOutputFeeDestinationNative: BigNumber;
  fixedCostUsd: number;
  sourceBridgeLatencySeconds: number;
  destinationBridgeLatencySeconds: number;
};
export type BridgeMatch = { family: EdgeFamily; effectiveBridgeName: string };
export type BridgeLookupContext = {
  chainId: number;
  adapterOrBridgeName: string;
  canonicalRemoteToken?: string;
  bridgedRemoteToken?: string;
  nativeUsdc?: string;
  l1SplitterBridges?: { name: string }[];
  l2SplitterBridges?: { name: string }[];
};

export type BinanceInternalAdapter = {
  _getAccountCoins(
    token: string,
    skipCache?: boolean
  ): Promise<{ networkList: Array<{ name: string; withdrawFee: string }> }>;
  _getEntrypointNetwork(chainId: number, token: string): Promise<number>;
  _getLatestPrice(
    sourceToken: string,
    destinationToken: string,
    sourceChain: number,
    amountToTransfer: BigNumber
  ): Promise<{ latestPrice: number; slippagePct: number }>;
  _getSymbol(
    sourceToken: string,
    destinationToken: string
  ): Promise<{
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    filters: Array<{
      filterType: string;
      tickSize?: string;
      stepSize?: string;
      minQty?: string;
      maxQty?: string;
    }>;
  }>;
  _getTradeFees(): Promise<Array<{ symbol: string; takerCommission: string }>>;
  _getSpotMarketMetaForRoute(
    sourceToken: string,
    destinationToken: string
  ): Promise<{ symbol: string; isBuy: boolean }>;
  _convertSourceToDestination(
    sourceToken: string,
    sourceChain: number,
    destinationToken: string,
    destinationChain: number,
    sourceAmount: BigNumber
  ): Promise<BigNumber>;
};

export type HyperliquidInternalAdapter = {
  _getLatestPrice(
    sourceToken: string,
    destinationToken: string,
    destinationChain: number,
    amountToTransfer: BigNumber,
    pxBuffer: number
  ): Promise<{ px: string; slippagePct: number }>;
  _getUserTakerFeePct(skipCache?: boolean): Promise<BigNumber>;
  _getSpotMarketMetaForRoute(sourceToken: string, destinationToken: string): { isBuy: boolean };
};

export type JussiHubContext = {
  hubPoolChainId: number;
};
export type JussiGraphTopology = {
  nodeContexts: ManagedNodeContext[];
  edgeCandidates: GraphEdgeCandidate[];
  logicalAssets: Record<string, JussiLogicalAssetDefinition>;
  requiredNativePriceChains: number[];
  rateLimitBuckets: JussiRateLimitBucketDefinition[];
};
export type PreparedGraphTopology = {
  relayerConfig: RelayerConfig;
  rebalancerConfig: RebalancerConfig;
  hubCtx: JussiHubContext;
  rebalanceRoutes: RebalanceRoute[];
  topology: JussiGraphTopology;
  topologyFingerprint: string;
};
export type PreparedGraphTopologyForBuild = Pick<
  PreparedGraphTopology,
  "relayerConfig" | "hubCtx" | "rebalanceRoutes" | "topology"
> &
  Partial<Pick<PreparedGraphTopology, "rebalancerConfig" | "topologyFingerprint">>;
export type BuildTopologyParams = {
  relayerConfig: RelayerConfig;
  rebalanceRoutes: RebalanceRoute[];
  hubCtx?: JussiHubContext;
};
// prettier-ignore
export type BuildGraphParams = { logger: winston.Logger; baseSigner: Signer; relayerConfig: RelayerConfig; inventoryClient: InventoryClient; rebalanceRoutes: RebalanceRoute[]; rebalancerAdapters: Record<string, RebalancerAdapter>; graphId?: string; now?: Date };
// prettier-ignore
export type JussiGraphLiveDeps = { logger: winston.Logger; baseSigner: Signer; inventoryClient: InventoryClient; rebalancerAdapters: Record<string, RebalancerAdapter>; graphId?: string; now?: Date };

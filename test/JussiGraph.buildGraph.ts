import { expect, sinon, toBNWei, winston } from "./utils";
import {
  CHAIN_IDs,
  EvmAddress,
  getMessengerEvm,
  getTokenInfoFromSymbol,
  resolveBinanceCoinSymbol,
  TOKEN_SYMBOLS_MAP,
} from "../src/utils";
import { RelayerConfig } from "../src/relayer/RelayerConfig";
import { RebalancerConfig } from "../src/rebalancer/RebalancerConfig";
import { buildRebalanceRoutes } from "../src/rebalancer/buildRebalanceRoutes";
import {
  buildSameAssetRebalanceRoutes,
  getSameAssetRebalanceRouteSupport,
} from "../src/rebalancer/buildSameAssetRebalanceRoutes";
import {
  BINANCE_RATE_LIMIT_BUCKET_ID,
  GraphEdgeCandidate,
  BuiltJussiGraph,
  ManagedNodeContext,
  buildJussiGraphBundleJson,
  buildJussiGraphUploadBundle,
  buildBridgeEdgeCandidates,
  buildCumulativeBalancePainDefinitions,
  buildLogicalAssetDefinitions,
  buildJussiGraphEnvelope,
  buildJussiGraphJson,
  buildJussiGraphId,
  buildJussiRateLimitBucketsJson,
  buildJussiTopologyArtifact,
  buildManagedNodeTemplates,
  dedupeGraphEdgeCandidates,
  materializeNodeDefinitions,
  prepareGraphTopology,
  quoteOftRouteTransfer,
  resolveBridgeLatencySeconds,
  resolveExchangeLatencySeconds,
  resolveGraphBridgeLatencySeconds,
  resolveOftQuoteExtraOptions,
  resolveOftQuoteSendFeeAsset,
  resolveOptionalTranslatedTokenAddress,
  resolveRequiredNativePriceChains,
  RuntimePricingContext,
  buildTopology,
  bundleHash,
  canonicalNodeKey,
  stableJsonStringify,
} from "../src/jussi/buildGraph";
import { JussiApiClient, putJsonWithTimeout } from "../src/jussi/JussiApiClient";
import {
  parseBuildJussiGraphFlags,
  resolveNativePriceChainIdsForPrices,
  resolveRuntimeRebalanceRoutes,
} from "../scripts/buildJussiGraph";
import { estimateEdgeEconomics, estimateQuotedBridgeBreakdown } from "../src/jussi/economics/edgeCosts";
import { serializeEdgeClassDefinition } from "../src/jussi/economics/rates";
import * as jussiQuotes from "../src/jussi/economics/quotes";
import { CCTP_MAX_SEND_AMOUNT } from "../src/common";
import {
  JUSSI_LAST_PUBLISHED_KEY,
  JUSSI_PUBLISH_LOCK_KEY,
  JussiGraphPublisher,
  validateJussiUploadEnv,
} from "../src/jussi/JussiGraphPublisher";

function findExpectedNode(
  nodeContexts: ManagedNodeContext[],
  predicate: (node: ManagedNodeContext) => boolean,
  description: string
): ManagedNodeContext {
  const node = nodeContexts.find(predicate);
  if (!node) {
    throw new Error(`Expected Jussi node not found: ${description}`);
  }
  return node;
}

function findExpectedEdge(
  edgeCandidates: GraphEdgeCandidate[],
  predicate: (candidate: GraphEdgeCandidate) => boolean,
  description: string
): GraphEdgeCandidate {
  const edge = edgeCandidates.find(predicate);
  if (!edge) {
    throw new Error(`Expected Jussi edge not found: ${description}`);
  }
  return edge;
}

function requireString(value: string | undefined, description: string): string {
  if (value === undefined) {
    throw new Error(`Expected string not found: ${description}`);
  }
  return value;
}

function expectParseError(args: string[], message: string): void {
  let errorMessage = "";
  try {
    parseBuildJussiGraphFlags(args);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }
  expect(errorMessage).to.contain(message);
}

function buildRelayerConfig(optimismUsdcTargetPct = 8): RelayerConfig {
  return new RelayerConfig({
    HUB_CHAIN_ID: String(CHAIN_IDs.MAINNET),
    RELAYER_INVENTORY_CONFIG: JSON.stringify({
      tokenConfig: {
        USDC: {
          USDC: {
            [CHAIN_IDs.OPTIMISM]: { targetPct: optimismUsdcTargetPct, thresholdPct: 4 },
            [CHAIN_IDs.BASE]: { targetPct: 6, thresholdPct: 3 },
          },
          "USDC.e": {
            [CHAIN_IDs.OPTIMISM]: { targetPct: 3, thresholdPct: 1 },
            [CHAIN_IDs.TEMPO]: { targetPct: 2, thresholdPct: 1 },
          },
          USDbC: {
            [CHAIN_IDs.BASE]: { targetPct: 2, thresholdPct: 1 },
          },
          pathUSD: {
            [CHAIN_IDs.TEMPO]: { targetPct: 1, thresholdPct: 1 },
          },
        },
        USDT: {
          [CHAIN_IDs.OPTIMISM]: { targetPct: 4, thresholdPct: 2 },
          [CHAIN_IDs.HYPEREVM]: { targetPct: 3, thresholdPct: 1 },
        },
        WETH: {
          [CHAIN_IDs.BASE]: { targetPct: 5, thresholdPct: 2 },
          [CHAIN_IDs.PLASMA]: { targetPct: 3, thresholdPct: 1 },
          [CHAIN_IDs.ZORA]: { targetPct: 1, thresholdPct: 0.5 },
        },
      },
      allowedSwapRoutes: [
        { fromChain: "ALL", fromToken: "USDC", toChain: CHAIN_IDs.TEMPO, toToken: "pathUSD" },
        { fromChain: CHAIN_IDs.TEMPO, fromToken: "pathUSD", toChain: "ALL", toToken: "USDC" },
      ],
      wrapEtherTarget: "0",
      wrapEtherTargetPerChain: {},
      wrapEtherThreshold: "0",
      wrapEtherThresholdPerChain: {},
    }),
  });
}

function buildRebalancerConfig(targetBalance = "100"): RebalancerConfig {
  return new RebalancerConfig({
    HUB_CHAIN_ID: String(CHAIN_IDs.MAINNET),
    REBALANCER_CONFIG: JSON.stringify({
      cumulativeTargetBalances: {
        USDC: {
          targetBalance,
          thresholdBalance: targetBalance === "0" ? "0" : "50",
          priorityTier: 0,
          chains: {
            [CHAIN_IDs.OPTIMISM]: 0,
            [CHAIN_IDs.BASE]: 0,
          },
        },
      },
      maxAmountsToTransfer: {},
      maxPendingOrders: {},
    }),
  });
}

type SameAssetRouteSupport = ReturnType<typeof getSameAssetRebalanceRouteSupport>[number];

function buildSameAssetRebalancerConfig(
  supportedRoutes: readonly SameAssetRouteSupport[] = getSameAssetRebalanceRouteSupport()
): RebalancerConfig {
  const sameAssetBalances = supportedRoutes.reduce<Record<string, { chains: Record<number, number> }>>(
    (balances, { token, chainId }) => {
      balances[token] ??= { chains: {} };
      balances[token].chains[chainId] = 0;
      return balances;
    },
    {}
  );

  return new RebalancerConfig({
    HUB_CHAIN_ID: String(CHAIN_IDs.MAINNET),
    REBALANCER_CONFIG: JSON.stringify({ sameAssetBalances }),
  });
}

function buildSameAssetRelayerConfig(
  supportedRoutes: readonly SameAssetRouteSupport[] = getSameAssetRebalanceRouteSupport(),
  omittedEndpoint?: { token: string; chainId: number }
): RelayerConfig {
  const configuredRoutes = buildSameAssetRebalanceRoutes(buildSameAssetRebalancerConfig(supportedRoutes));
  const tokenConfig = configuredRoutes.reduce<
    Record<string, Record<number, { targetPct: number; thresholdPct: number }>>
  >((config, route) => {
    config[route.destinationToken] ??= {};
    config[route.destinationToken][route.destinationChain] = { targetPct: 1, thresholdPct: 0 };
    return config;
  }, {});
  if (omittedEndpoint) {
    delete tokenConfig[omittedEndpoint.token]?.[omittedEndpoint.chainId];
  }

  return new RelayerConfig({
    HUB_CHAIN_ID: String(CHAIN_IDs.MAINNET),
    RELAYER_INVENTORY_CONFIG: JSON.stringify({
      tokenConfig,
      allowedSwapRoutes: [],
      wrapEtherTarget: "0",
      wrapEtherTargetPerChain: {},
      wrapEtherThreshold: "0",
      wrapEtherThresholdPerChain: {},
    }),
  });
}

function rebalanceRouteMatches(
  actual: {
    sourceChain: number;
    sourceToken: string;
    destinationChain: number;
    destinationToken: string;
    adapter: string;
  },
  expected: {
    sourceChain: number;
    sourceToken: string;
    destinationChain: number;
    destinationToken: string;
    adapter: string;
  }
): boolean {
  return (
    actual.sourceChain === expected.sourceChain &&
    actual.sourceToken === expected.sourceToken &&
    actual.destinationChain === expected.destinationChain &&
    actual.destinationToken === expected.destinationToken &&
    actual.adapter === expected.adapter
  );
}

function buildNoopLogger(): winston.Logger {
  return { info: () => undefined, debug: () => undefined, warn: () => undefined } as never;
}

function buildMinimalGraph(graphId: string): BuiltJussiGraph {
  return {
    graphId,
    rate_limit_buckets: [],
    payload: {
      latency_annualized_cost_rate: "0.05",
      pain_model: {
        surplus_annualized_cost_rate: "0.000219",
        deficit_annualized_cost_rate: "0.002055",
        out_of_band_severity_multiplier: "4.0",
      },
      logical_assets: { USDC: { decimals_by_chain: { "1": 6 } } },
      cumulative_balance_pain: {},
      edge_classes: [],
      nodes: [],
      edges: [],
    },
  };
}

function buildMockPricingContext(): RuntimePricingContext {
  return {
    hubPoolChainId: CHAIN_IDs.MAINNET,
    getLogicalAssetPriceUsd: async () => 1,
    deriveGasCostUsd: async () => 0,
    nativeValueToUsd: async () => 0,
    tokenValueToUsd: async () => 0,
    usdToNativeValue: async () => toBNWei("0"),
  } as unknown as RuntimePricingContext;
}

function buildBinanceSwapCandidate(source: ManagedNodeContext, destination: ManagedNodeContext): GraphEdgeCandidate {
  return {
    family: "binance",
    adapterOrBridgeName: "binance",
    from: source,
    to: destination,
    rebalanceRoute: {
      sourceChain: source.chainId,
      sourceToken: source.logicalAsset,
      destinationChain: destination.chainId,
      destinationToken: destination.logicalAsset,
      adapter: "binance",
    },
  };
}

class InMemoryJussiRedis {
  private values = new Map<string, { value: string; expiresAt?: number }>();

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.values.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set<T>(key: string, val: T, expirySeconds = 60): Promise<string> {
    this.values.set(key, {
      value: String(val),
      ...(expirySeconds === Number.POSITIVE_INFINITY ? {} : { expiresAt: Date.now() + expirySeconds * 1000 }),
    });
    return "OK";
  }

  async ttl(key: string): Promise<number | undefined> {
    const entry = this.values.get(key);
    if (!entry) {
      return -2;
    }
    if (!entry.expiresAt) {
      return -1;
    }
    return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  }

  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
  }

  async acquireLock(key: string, token: string, ttlMs: number): Promise<boolean> {
    if (await this.get(key)) {
      return false;
    }
    this.values.set(key, { value: token, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async renewLock(key: string, token: string, ttlMs: number): Promise<boolean> {
    const entry = this.values.get(key);
    if (!entry || entry.value !== token) {
      return false;
    }
    entry.expiresAt = Date.now() + ttlMs;
    return true;
  }

  async releaseLock(key: string, token: string): Promise<boolean> {
    const entry = this.values.get(key);
    if (!entry || entry.value !== token) {
      return false;
    }
    this.values.delete(key);
    return true;
  }
}

class MetadataFailingJussiRedis extends InMemoryJussiRedis {
  async set<T>(key: string, val: T, expirySeconds = 60): Promise<string> {
    if (key === JUSSI_LAST_PUBLISHED_KEY) {
      throw new Error("metadata write failed");
    }
    return super.set(key, val, expirySeconds);
  }
}

class RenewFailingJussiRedis extends InMemoryJussiRedis {
  renewCalls = 0;

  async renewLock(_key: string, _token: string, _ttlMs: number): Promise<boolean> {
    this.renewCalls += 1;
    return false;
  }
}

class SecondRenewFailingJussiRedis extends InMemoryJussiRedis {
  renewCalls = 0;

  async renewLock(key: string, token: string, ttlMs: number): Promise<boolean> {
    this.renewCalls += 1;
    if (this.renewCalls === 1) {
      return super.renewLock(key, token, ttlMs);
    }
    return false;
  }
}

describe("Jussi graph builder helpers", function () {
  it("parses topology-only CLI modes explicitly", function () {
    expect(parseBuildJussiGraphFlags([])).to.deep.equal({
      check: false,
      topologyOnly: false,
      upload: false,
    });
    expect(parseBuildJussiGraphFlags(["--topology-only"])).to.deep.equal({
      check: false,
      topologyOnly: true,
      upload: false,
    });
    expect(parseBuildJussiGraphFlags(["--topology-only", "--check"])).to.deep.equal({
      check: true,
      topologyOnly: true,
      upload: false,
    });
    expect(parseBuildJussiGraphFlags(["--upload"])).to.deep.equal({
      check: false,
      topologyOnly: false,
      upload: true,
    });
    expect(parseBuildJussiGraphFlags(["--relayerAddress", "0x0000000000000000000000000000000000000001"])).to.deep.equal(
      {
        check: false,
        relayerAddress: "0x0000000000000000000000000000000000000001",
        topologyOnly: false,
        upload: false,
      }
    );
    expectParseError(["--check"], "--check requires --topology-only");
    expectParseError(["--topology-only", "--upload"], "--topology-only and --upload are mutually exclusive");
    expectParseError(["--relayerAddress"], "--relayerAddress requires an address");
  });

  it("extracts mainnet and aliased USDC/USDT/WETH node templates from synthetic inventory config", async function () {
    const relayerConfig = buildRelayerConfig();
    const templates = buildManagedNodeTemplates(relayerConfig.inventoryConfig, CHAIN_IDs.MAINNET);
    const hasNode = (chainId: number, symbol: string) =>
      templates.some((template) => template.chainId === chainId && template.symbol === symbol);
    const hasLogicalAssetNode = (chainId: number, logicalAsset: string) =>
      templates.some((template) => template.chainId === chainId && template.logicalAsset === logicalAsset);

    expect(hasNode(CHAIN_IDs.MAINNET, "USDC")).to.equal(true);
    expect(hasNode(CHAIN_IDs.MAINNET, "USDT")).to.equal(true);
    expect(hasNode(CHAIN_IDs.OPTIMISM, "USDC")).to.equal(true);
    expect(hasNode(CHAIN_IDs.OPTIMISM, "USDC.e")).to.equal(true);
    expect(hasNode(CHAIN_IDs.BASE, "USDC")).to.equal(true);
    expect(hasNode(CHAIN_IDs.BASE, "USDbC")).to.equal(true);
    expect(hasNode(CHAIN_IDs.TEMPO, "USDC.e")).to.equal(true);
    expect(hasNode(CHAIN_IDs.TEMPO, "pathUSD")).to.equal(true);
    expect(hasNode(CHAIN_IDs.HYPEREVM, "USDT")).to.equal(true);
    expect(hasLogicalAssetNode(CHAIN_IDs.BASE, "WETH")).to.equal(true);
    expect(hasLogicalAssetNode(CHAIN_IDs.PLASMA, "WETH")).to.equal(true);
    expect(hasLogicalAssetNode(CHAIN_IDs.ZORA, "WETH")).to.equal(true);
  });

  it("normalizes allocation ratios per logical asset and emits cumulative balance pain bands", async function () {
    const relayerConfig = buildRelayerConfig();
    const nodeContexts = materializeNodeDefinitions(buildManagedNodeTemplates(relayerConfig.inventoryConfig));
    const optimismUsdc = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.OPTIMISM && node.symbol === "USDC" && node.logicalAsset === "USDC",
      "Optimism USDC"
    );
    const mainnetUsdc = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.MAINNET && node.symbol === "USDC" && node.logicalAsset === "USDC",
      "Mainnet USDC"
    );
    const cumulativeBalancePain = buildCumulativeBalancePainDefinitions({
      USDC: toBNWei("1000", 6),
      USDT: toBNWei("500", 6),
      WETH: toBNWei("10", 18),
    });
    const targetSums = nodeContexts.reduce<Record<string, number>>((sums, node) => {
      sums[node.logicalAsset] = (sums[node.logicalAsset] ?? 0) + Number(node.definition.target_allocation_ratio);
      return sums;
    }, {});

    expect(Number(optimismUsdc.definition.target_allocation_ratio)).to.be.closeTo(8 / 22, 1e-12);
    expect(Number(optimismUsdc.definition.min_allocation_ratio)).to.be.closeTo(4 / 22, 1e-12);
    expect(Number(optimismUsdc.definition.max_allocation_ratio)).to.be.closeTo(12 / 22, 1e-12);
    expect(mainnetUsdc.definition.target_allocation_ratio).to.equal("0");
    expect(mainnetUsdc.definition.min_allocation_ratio).to.equal("0");
    expect(mainnetUsdc.definition.max_allocation_ratio).to.equal("0");
    expect(targetSums.USDC).to.be.closeTo(1, 1e-12);
    expect(targetSums.USDT).to.be.closeTo(1, 1e-12);
    expect(targetSums.WETH).to.be.closeTo(1, 1e-12);

    expect(cumulativeBalancePain.USDC).to.deep.equal({
      target_balance_native: toBNWei("1000", 6).toString(),
      min_threshold_native: toBNWei("900", 6).toString(),
      max_threshold_native: toBNWei("1100", 6).toString(),
      surplus_annualized_cost_rate: "0.000219",
      deficit_annualized_cost_rate: "0.002055",
      out_of_band_severity_multiplier: "4.0",
    });
    expect(cumulativeBalancePain.USDT).to.deep.equal({
      target_balance_native: toBNWei("500", 6).toString(),
      min_threshold_native: toBNWei("450", 6).toString(),
      max_threshold_native: toBNWei("550", 6).toString(),
      surplus_annualized_cost_rate: "0.000219",
      deficit_annualized_cost_rate: "0.002055",
      out_of_band_severity_multiplier: "4.0",
    });
    expect(cumulativeBalancePain.WETH).to.deep.equal({
      target_balance_native: toBNWei("10", 18).toString(),
      min_threshold_native: toBNWei("9.5", 18).toString(),
      max_threshold_native: toBNWei("10.5", 18).toString(),
      surplus_annualized_cost_rate: "0.000219",
      deficit_annualized_cost_rate: "0.002055",
      out_of_band_severity_multiplier: "8.0",
    });
  });

  it("uses cumulative balances with approximate upcoming refunds as cumulative pain targets", async function () {
    const relayerConfig = new RelayerConfig({
      HUB_CHAIN_ID: String(CHAIN_IDs.MAINNET),
      RELAYER_INVENTORY_CONFIG: JSON.stringify({
        tokenConfig: {},
        allowedSwapRoutes: [],
        wrapEtherTarget: "0",
        wrapEtherTargetPerChain: {},
        wrapEtherThreshold: "0",
        wrapEtherThresholdPerChain: {},
      }),
    });
    const balances = {
      USDC: toBNWei("1234", 6),
      USDT: toBNWei("5678", 6),
      WETH: toBNWei("9.75", 18),
    };
    const requestedTokens: string[] = [];
    const inventoryClient = {
      getCumulativeBalanceWithApproximateUpcomingRefunds(l1Token: EvmAddress) {
        const tokenAddress = l1Token.toNative().toLowerCase();
        requestedTokens.push(tokenAddress);

        if (tokenAddress === TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET].toLowerCase()) {
          return balances.USDC;
        }
        if (tokenAddress === TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET].toLowerCase()) {
          return balances.USDT;
        }
        if (tokenAddress === TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET].toLowerCase()) {
          return balances.WETH;
        }

        throw new Error(`unexpected token lookup: ${tokenAddress}`);
      },
    };

    const describeGasPricesStub = sinon
      .stub(RuntimePricingContext.prototype, "describeGasPrices")
      .callsFake(async (chainIds: number[]) =>
        Array.from(new Set(chainIds)).map((chainId) => ({
          chainId,
          gasPriceWei: "1",
          gasPriceGwei: "0.000000001",
          source: "fallback_current_oracle",
        }))
      );
    let uploadBundle: Awaited<ReturnType<typeof buildJussiGraphUploadBundle>>;
    try {
      uploadBundle = await buildJussiGraphUploadBundle({
        logger: { info: () => undefined, debug: () => undefined } as never,
        baseSigner: {} as never,
        relayerConfig,
        inventoryClient: inventoryClient as never,
        rebalanceRoutes: [],
        rebalancerAdapters: {},
        graphId: "test-graph",
      });
    } finally {
      describeGasPricesStub.restore();
    }
    const { graph } = uploadBundle;

    expect(requestedTokens).to.deep.equal([
      TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET].toLowerCase(),
      TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET].toLowerCase(),
      TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET].toLowerCase(),
    ]);
    expect(graph.payload.nodes).to.have.lengthOf(3);
    expect(graph.payload.edges).to.have.lengthOf(0);
    expect(graph.payload.cumulative_balance_pain.USDC.target_balance_native).to.equal(balances.USDC.toString());
    expect(graph.payload.cumulative_balance_pain.USDT.target_balance_native).to.equal(balances.USDT.toString());
    expect(graph.payload.cumulative_balance_pain.WETH.target_balance_native).to.equal(balances.WETH.toString());
    expect(graph.payload.logical_assets.WETH.native_price_alias_chain_ids).to.deep.equal(["1"]);
    expect(graph.payload.logical_assets.USDC.native_price_alias_chain_ids).to.equal(undefined);
    expect(uploadBundle.graphId).to.equal("test-graph");
    expect(uploadBundle.bundle).to.deep.equal(buildJussiGraphBundleJson(graph));
    expect(uploadBundle.envelope).to.deep.equal(buildJussiGraphEnvelope(graph));
    expect(uploadBundle.bundleHash).to.equal(bundleHash(uploadBundle.bundle));
  });

  it("splits graph native price coverage between aliases and explicit native request prices", async function () {
    const nodeContexts = materializeNodeDefinitions(buildManagedNodeTemplates(buildRelayerConfig().inventoryConfig));
    const logicalAssets = buildLogicalAssetDefinitions(nodeContexts);
    const aliasedChainIds = new Set(
      Object.values(logicalAssets).flatMap((definition) => (definition.native_price_alias_chain_ids ?? []).map(Number))
    );
    const requiredNativePriceChains = resolveRequiredNativePriceChains(logicalAssets, nodeContexts);
    const graphChainIds = [...new Set(nodeContexts.map((node) => node.chainId))].sort((a, b) => a - b);
    const graphJson = {
      logical_assets: logicalAssets,
      nodes: nodeContexts.map((node) => node.definition),
    };

    expect(logicalAssets.HYPE).to.equal(undefined);
    expect([...aliasedChainIds].sort((a, b) => a - b)).to.deep.equal([
      CHAIN_IDs.MAINNET,
      CHAIN_IDs.TEMPO,
      CHAIN_IDs.BASE,
      CHAIN_IDs.ZORA,
    ]);
    expect(requiredNativePriceChains).to.deep.equal([CHAIN_IDs.OPTIMISM, CHAIN_IDs.HYPEREVM, CHAIN_IDs.PLASMA]);
    expect([...new Set([...aliasedChainIds, ...requiredNativePriceChains])].sort((a, b) => a - b)).to.deep.equal(
      graphChainIds
    );
    expect(resolveNativePriceChainIdsForPrices(graphJson)).to.deep.equal(requiredNativePriceChains);
  });

  it("discovers only direct token-splitter bridge candidates for pathUSD", async function () {
    const relayerConfig = buildRelayerConfig();
    const nodeContexts = materializeNodeDefinitions(buildManagedNodeTemplates(relayerConfig.inventoryConfig));
    const edgeCandidates = buildBridgeEdgeCandidates(nodeContexts);

    const mainnetUsdc = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.MAINNET && node.symbol === "USDC" && node.logicalAsset === "USDC",
      "Mainnet USDC"
    );
    const optimismUsdc = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.OPTIMISM && node.symbol === "USDC" && node.logicalAsset === "USDC",
      "Optimism USDC"
    );
    const tempoUsdc = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.TEMPO && node.symbol === "USDC.e",
      "Tempo USDC.e"
    );
    const pathUsd = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.TEMPO && node.symbol === "pathUSD",
      "Tempo pathUSD"
    );

    expect(
      edgeCandidates.some(
        (edge) =>
          edge.family === "bridgeapi" &&
          edge.from.nodeKey === mainnetUsdc.nodeKey &&
          edge.to.nodeKey === pathUsd.nodeKey
      )
    ).to.equal(true);
    expect(
      edgeCandidates.some(
        (edge) =>
          edge.family === "bridgeapi" &&
          edge.from.nodeKey === pathUsd.nodeKey &&
          edge.to.nodeKey === mainnetUsdc.nodeKey
      )
    ).to.equal(false);
    expect(
      edgeCandidates.some(
        (edge) =>
          edge.family === "oft" && edge.from.nodeKey === mainnetUsdc.nodeKey && edge.to.nodeKey === tempoUsdc.nodeKey
      )
    ).to.equal(true);
    expect(
      edgeCandidates.some(
        (edge) =>
          edge.family === "oft" && edge.from.nodeKey === tempoUsdc.nodeKey && edge.to.nodeKey === mainnetUsdc.nodeKey
      )
    ).to.equal(true);
    expect(
      edgeCandidates.some((edge) => edge.from.nodeKey === optimismUsdc.nodeKey && edge.to.nodeKey === pathUsd.nodeKey)
    ).to.equal(false);
    expect(
      edgeCandidates.some((edge) => edge.from.nodeKey === pathUsd.nodeKey && edge.to.nodeKey === optimismUsdc.nodeKey)
    ).to.equal(false);
  });

  it("dedupes identical edges while preserving parallel adapters", async function () {
    const relayerConfig = buildRelayerConfig();
    const nodeContexts = materializeNodeDefinitions(buildManagedNodeTemplates(relayerConfig.inventoryConfig));
    const mainnetUsdc = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.MAINNET && node.symbol === "USDC" && node.logicalAsset === "USDC",
      "Mainnet USDC"
    );
    const pathUsd = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.TEMPO && node.symbol === "pathUSD",
      "Tempo pathUSD"
    );
    const hyperevmUsdt = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.HYPEREVM && node.symbol === "USDT",
      "HyperEVM USDT"
    );
    const optimismUsdc = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.OPTIMISM && node.symbol === "USDC",
      "Optimism USDC"
    );

    const candidates: GraphEdgeCandidate[] = [
      {
        family: "bridgeapi",
        adapterOrBridgeName: "BridgeApi",
        effectiveBridgeName: "BridgeApi",
        from: mainnetUsdc,
        to: pathUsd,
      },
      {
        family: "bridgeapi",
        adapterOrBridgeName: "BridgeApi",
        effectiveBridgeName: "BridgeApi",
        from: mainnetUsdc,
        to: pathUsd,
      },
      {
        family: "cctp",
        adapterOrBridgeName: "UsdcCCTPBridge",
        effectiveBridgeName: "UsdcCCTPBridge",
        from: mainnetUsdc,
        to: optimismUsdc,
      },
      {
        family: "cctp",
        adapterOrBridgeName: "cctp",
        from: mainnetUsdc,
        to: optimismUsdc,
        rebalanceRoute: {
          sourceChain: CHAIN_IDs.MAINNET,
          sourceToken: "USDC",
          destinationChain: CHAIN_IDs.OPTIMISM,
          destinationToken: "USDC",
          adapter: "cctp",
        },
      },
      {
        family: "binance",
        adapterOrBridgeName: "binance",
        from: hyperevmUsdt,
        to: optimismUsdc,
        rebalanceRoute: {
          sourceChain: CHAIN_IDs.HYPEREVM,
          sourceToken: "USDT",
          destinationChain: CHAIN_IDs.OPTIMISM,
          destinationToken: "USDC",
          adapter: "binance",
        },
      },
      {
        family: "hyperliquid",
        adapterOrBridgeName: "hyperliquid",
        from: hyperevmUsdt,
        to: optimismUsdc,
        rebalanceRoute: {
          sourceChain: CHAIN_IDs.HYPEREVM,
          sourceToken: "USDT",
          destinationChain: CHAIN_IDs.OPTIMISM,
          destinationToken: "USDC",
          adapter: "hyperliquid",
        },
      },
    ];

    const deduped = dedupeGraphEdgeCandidates(candidates);

    expect(deduped).to.have.lengthOf(4);
    expect(deduped.filter((candidate) => candidate.from.nodeKey === hyperevmUsdt.nodeKey)).to.have.lengthOf(2);
    expect(
      deduped.filter(
        (candidate) =>
          candidate.family === "cctp" &&
          candidate.from.nodeKey === mainnetUsdc.nodeKey &&
          candidate.to.nodeKey === optimismUsdc.nodeKey
      )
    ).to.have.lengthOf(1);
  });

  it("computes exchange latencies with optional intermediate bridge legs", async function () {
    const cctpLatency = resolveBridgeLatencySeconds("cctp", CHAIN_IDs.OPTIMISM, "USDC");
    const oftLatency = resolveBridgeLatencySeconds("oft", CHAIN_IDs.OPTIMISM, "USDT");
    const slowOftLatency = resolveBridgeLatencySeconds("oft", CHAIN_IDs.HYPEREVM, "USDT");

    expect(resolveExchangeLatencySeconds({ family: "binance" })).to.equal(300);
    expect(resolveExchangeLatencySeconds({ family: "hyperliquid" })).to.equal(300);
    expect(resolveExchangeLatencySeconds({ family: "binance", sourceBridgeLatencySeconds: cctpLatency })).to.equal(
      1500
    );
    expect(resolveExchangeLatencySeconds({ family: "hyperliquid", sourceBridgeLatencySeconds: oftLatency })).to.equal(
      1500
    );
    expect(
      resolveExchangeLatencySeconds({
        family: "binance",
        sourceBridgeLatencySeconds: cctpLatency,
        destinationBridgeLatencySeconds: slowOftLatency,
      })
    ).to.equal(87900);
  });

  it("discovers WETH bridge candidates from constants and applies WETH bridge latency overrides", async function () {
    const relayerConfig = buildRelayerConfig();
    const nodeContexts = materializeNodeDefinitions(buildManagedNodeTemplates(relayerConfig.inventoryConfig));
    const bridgeCandidates = buildBridgeEdgeCandidates(nodeContexts);
    const hasBridge = (
      sourceChain: number,
      sourceToken: string,
      destinationChain: number,
      destinationToken: string,
      family: string
    ) =>
      bridgeCandidates.some(
        (candidate) =>
          candidate.from.chainId === sourceChain &&
          candidate.from.logicalAsset === sourceToken &&
          candidate.to.chainId === destinationChain &&
          candidate.to.logicalAsset === destinationToken &&
          candidate.family === family
      );

    expect(hasBridge(CHAIN_IDs.MAINNET, "WETH", CHAIN_IDs.BASE, "WETH", "canonical")).to.equal(true);
    expect(hasBridge(CHAIN_IDs.BASE, "WETH", CHAIN_IDs.MAINNET, "WETH", "binance_cex_bridge")).to.equal(true);
    expect(hasBridge(CHAIN_IDs.MAINNET, "WETH", CHAIN_IDs.PLASMA, "WETH", "oft")).to.equal(true);
    expect(hasBridge(CHAIN_IDs.PLASMA, "WETH", CHAIN_IDs.MAINNET, "WETH", "oft")).to.equal(true);
    expect(hasBridge(CHAIN_IDs.MAINNET, "WETH", CHAIN_IDs.ZORA, "WETH", "canonical")).to.equal(true);
    expect(hasBridge(CHAIN_IDs.ZORA, "WETH", CHAIN_IDs.MAINNET, "WETH", "canonical")).to.equal(true);

    const zoraToMainnet = findExpectedEdge(
      bridgeCandidates,
      (candidate) =>
        candidate.from.chainId === CHAIN_IDs.ZORA &&
        candidate.to.chainId === CHAIN_IDs.MAINNET &&
        candidate.from.logicalAsset === "WETH",
      "Zora WETH to mainnet"
    );
    const mainnetToZora = findExpectedEdge(
      bridgeCandidates,
      (candidate) =>
        candidate.from.chainId === CHAIN_IDs.MAINNET &&
        candidate.to.chainId === CHAIN_IDs.ZORA &&
        candidate.from.logicalAsset === "WETH",
      "Mainnet WETH to Zora"
    );
    const plasmaToMainnet = findExpectedEdge(
      bridgeCandidates,
      (candidate) =>
        candidate.from.chainId === CHAIN_IDs.PLASMA &&
        candidate.to.chainId === CHAIN_IDs.MAINNET &&
        candidate.from.logicalAsset === "WETH",
      "Plasma WETH to mainnet"
    );

    expect(resolveGraphBridgeLatencySeconds(zoraToMainnet)).to.equal(7 * 24 * 60 * 60);
    expect(resolveGraphBridgeLatencySeconds(mainnetToZora)).to.equal(20 * 60);
    expect(resolveGraphBridgeLatencySeconds(plasmaToMainnet)).to.equal(20 * 60);
    expect(
      resolveGraphBridgeLatencySeconds(
        findExpectedEdge(
          bridgeCandidates,
          (candidate) => candidate.family === "binance_cex_bridge",
          "Binance CEX bridge"
        )
      )
    ).to.equal(5 * 60);
  });

  it("skips bridged USDC lookups on chains that only support native USDC", async function () {
    const mainnetUsdc = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]);
    const mainnetUsdt = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET]);

    expect(resolveOptionalTranslatedTokenAddress(mainnetUsdc, CHAIN_IDs.UNICHAIN)).to.equal(undefined);
    expect(resolveOptionalTranslatedTokenAddress(mainnetUsdc, CHAIN_IDs.OPTIMISM)).to.equal(
      TOKEN_SYMBOLS_MAP["USDC.e"].addresses[CHAIN_IDs.OPTIMISM].toLowerCase()
    );
    expect(resolveOptionalTranslatedTokenAddress(mainnetUsdt, CHAIN_IDs.HYPEREVM)).to.equal(
      TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.HYPEREVM].toLowerCase()
    );
  });

  it("applies Binance taker commission as a fractional rate in edge classes", async function () {
    const relayerConfig = buildRelayerConfig();
    const nodeContexts = materializeNodeDefinitions(buildManagedNodeTemplates(relayerConfig.inventoryConfig));
    const source = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.MAINNET && node.logicalAsset === "USDC",
      "Mainnet USDC"
    );
    const destination = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.MAINNET && node.logicalAsset === "USDT",
      "Mainnet USDT"
    );
    const candidate = buildBinanceSwapCandidate(source, destination);
    const adapter = {
      async _getSpotMarketMetaForRoute() {
        return { symbol: "USDCUSDT", isBuy: false };
      },
      async _convertSourceToDestination(
        _sourceToken: string,
        _sourceChain: number,
        _destinationToken: string,
        _destinationChain: number,
        amount: unknown
      ) {
        return amount;
      },
      async _getTradeFees() {
        return [{ symbol: "USDCUSDT", takerCommission: "0.001" }];
      },
    };

    const edgeClass = await serializeEdgeClassDefinition(candidate, {
      baseSigner: {} as never,
      pricingContext: buildMockPricingContext(),
      rebalancerAdapters: { binance: adapter } as never,
    });

    expect(edgeClass.output.segments).to.have.lengthOf(1);
    expect(edgeClass.output.segments[0].marginal_output_rate).to.deep.equal({
      numerator: "999000",
      denominator: "1000000",
    });
  });

  it("rejects Binance swap pricing when the configured withdraw network is missing", async function () {
    const relayerConfig = buildRelayerConfig();
    const nodeContexts = materializeNodeDefinitions(buildManagedNodeTemplates(relayerConfig.inventoryConfig));
    const source = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.MAINNET && node.logicalAsset === "USDC",
      "Mainnet USDC"
    );
    const destination = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.HYPEREVM && node.logicalAsset === "USDT",
      "HyperEVM USDT"
    );
    const candidate = buildBinanceSwapCandidate(source, destination);
    const adapter = {
      async _getAccountCoins() {
        return { networkList: [{ name: "ETH", withdrawFee: "0.1" }] };
      },
      async _getEntrypointNetwork(chainId: number) {
        return chainId;
      },
    };

    let errorMessage = "";
    try {
      await estimateEdgeEconomics(candidate, {
        baseSigner: {} as never,
        cumulativeBalancesByLogicalAsset: { USDC: toBNWei("0"), USDT: toBNWei("0"), WETH: toBNWei("0") },
        logger: buildNoopLogger(),
        pricingContext: buildMockPricingContext(),
        rebalancerAdapters: { binance: adapter } as never,
      });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).to.contain(`No Binance network entry for USDT on chain ${CHAIN_IDs.HYPEREVM}`);
  });

  it("includes CCTP maxFee as a fixed input fee on CCTP edges", async function () {
    const relayerConfig = buildRelayerConfig();
    const nodeContexts = materializeNodeDefinitions(buildManagedNodeTemplates(relayerConfig.inventoryConfig));
    const source = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.MAINNET && node.logicalAsset === "USDC",
      "Mainnet USDC"
    );
    const destination = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.OPTIMISM && node.logicalAsset === "USDC",
      "Optimism USDC"
    );
    const rebalanceRoute = {
      sourceChain: CHAIN_IDs.MAINNET,
      sourceToken: "USDC",
      destinationChain: CHAIN_IDs.OPTIMISM,
      destinationToken: "USDC",
      adapter: "cctp",
    } as const;
    const candidate: GraphEdgeCandidate = {
      family: "cctp",
      adapterOrBridgeName: "cctp",
      from: source,
      to: destination,
      rebalanceRoute,
    };
    const cctpMaxFee = toBNWei("1.25", 6);
    const cctpAdapter = { getEstimatedCost: sinon.stub().resolves(cctpMaxFee) };

    const economics = await estimateEdgeEconomics(candidate, {
      baseSigner: {} as never,
      cumulativeBalancesByLogicalAsset: { USDC: toBNWei("0"), USDT: toBNWei("0"), WETH: toBNWei("0") },
      logger: buildNoopLogger(),
      pricingContext: buildMockPricingContext(),
      rebalancerAdapters: { cctp: cctpAdapter } as never,
    });

    expect(economics.fixedInputFeeNative.toString()).to.equal(cctpMaxFee.toString());
    expect(economics.fixedOutputFeeNative.toString()).to.equal("0");
    expect(cctpAdapter.getEstimatedCost.calledOnce).to.equal(true);
    expect(cctpAdapter.getEstimatedCost.firstCall.args[0]).to.deep.equal(rebalanceRoute);
    expect(cctpAdapter.getEstimatedCost.firstCall.args[2]).to.equal(false);
  });

  it("adds CCTP maxFee to exchange edges that use a CCTP destination bridge leg", async function () {
    const relayerConfig = buildRelayerConfig();
    const nodeContexts = materializeNodeDefinitions(buildManagedNodeTemplates(relayerConfig.inventoryConfig));
    const source = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.MAINNET && node.logicalAsset === "WETH",
      "Mainnet WETH"
    );
    const destination = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.OPTIMISM && node.logicalAsset === "USDC",
      "Optimism USDC"
    );
    const candidate = buildBinanceSwapCandidate(source, destination);
    const destinationBridgeAmount = toBNWei("2500", 6);
    const cctpMaxFee = toBNWei("2.5", 6);
    const convertSourceToDestinationStub = sinon.stub().resolves(destinationBridgeAmount);
    const cctpAdapter = { getEstimatedCost: sinon.stub().resolves(cctpMaxFee) };
    const adapter = {
      async _getAccountCoins() {
        return { networkList: [{ name: "ETH", withdrawFee: "0" }] };
      },
      async _getEntrypointNetwork(chainId: number, token: string) {
        return token === "USDC" && chainId === CHAIN_IDs.OPTIMISM ? CHAIN_IDs.MAINNET : chainId;
      },
      _convertSourceToDestination: convertSourceToDestinationStub,
    };

    const economics = await estimateEdgeEconomics(candidate, {
      baseSigner: {} as never,
      cumulativeBalancesByLogicalAsset: { USDC: toBNWei("0"), USDT: toBNWei("0"), WETH: toBNWei("0") },
      logger: buildNoopLogger(),
      pricingContext: buildMockPricingContext(),
      rebalancerAdapters: { binance: adapter, cctp: cctpAdapter } as never,
    });

    expect(economics.fixedOutputFeeNative.toString()).to.equal(cctpMaxFee.toString());
    expect(cctpAdapter.getEstimatedCost.calledOnce).to.equal(true);
    expect(cctpAdapter.getEstimatedCost.firstCall.args[0]).to.deep.equal({
      sourceChain: CHAIN_IDs.MAINNET,
      sourceToken: "USDC",
      destinationChain: CHAIN_IDs.OPTIMISM,
      destinationToken: "USDC",
      adapter: "cctp",
    });
    expect(cctpAdapter.getEstimatedCost.firstCall.args[1].toString()).to.equal(destinationBridgeAmount.toString());
  });

  it("caps Binance swap capacity by CCTP source bridge limits", async function () {
    const relayerConfig = buildRelayerConfig();
    const nodeContexts = materializeNodeDefinitions(buildManagedNodeTemplates(relayerConfig.inventoryConfig));
    const source = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.OPTIMISM && node.logicalAsset === "USDC",
      "Optimism USDC"
    );
    const destination = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.MAINNET && node.logicalAsset === "WETH",
      "Mainnet WETH"
    );
    const candidate = buildBinanceSwapCandidate(source, destination);
    const cctpAdapter = { getEstimatedCost: sinon.stub().resolves(toBNWei("0", 6)) };
    const adapter = {
      async _getAccountCoins() {
        return { networkList: [{ name: "ETH", withdrawFee: "0" }] };
      },
      async _getEntrypointNetwork(chainId: number, token: string) {
        return token === "USDC" && chainId === CHAIN_IDs.OPTIMISM ? CHAIN_IDs.MAINNET : chainId;
      },
    };

    const economics = await estimateEdgeEconomics(candidate, {
      baseSigner: {} as never,
      cumulativeBalancesByLogicalAsset: { USDC: toBNWei("0"), USDT: toBNWei("0"), WETH: toBNWei("0") },
      logger: buildNoopLogger(),
      pricingContext: buildMockPricingContext(),
      rebalancerAdapters: { binance: adapter, cctp: cctpAdapter } as never,
    });

    expect(economics.inputCapacityNative.toString()).to.equal(CCTP_MAX_SEND_AMOUNT.toString());
    expect(cctpAdapter.getEstimatedCost.calledOnce).to.equal(true);
    expect(cctpAdapter.getEstimatedCost.firstCall.args[1].toString()).to.equal(toBNWei("100000", 6).toString());
  });

  it("caps bridged Binance withdrawal capacity by withdrawMax", async function () {
    const relayerConfig = buildRelayerConfig();
    const nodeContexts = materializeNodeDefinitions(buildManagedNodeTemplates(relayerConfig.inventoryConfig));
    const source = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.MAINNET && node.logicalAsset === "WETH",
      "Mainnet WETH"
    );
    const destination = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.OPTIMISM && node.logicalAsset === "USDC",
      "Optimism USDC"
    );
    const candidate = buildBinanceSwapCandidate(source, destination);
    const sampledCapacityNative = toBNWei("100000", 18);
    const expectedExecutableCapacityNative = toBNWei("50000", 18);
    const destinationOutputAtSampleCapacity = toBNWei("2000", 6);
    const destinationBridgeAmount = toBNWei("2500", 6);
    const convertSourceToDestinationStub = sinon
      .stub()
      .onFirstCall()
      .resolves(destinationOutputAtSampleCapacity)
      .onSecondCall()
      .resolves(destinationBridgeAmount);
    const cctpAdapter = { getEstimatedCost: sinon.stub().resolves(toBNWei("0", 6)) };
    const adapter = {
      async _getAccountCoins() {
        return { networkList: [{ name: "ETH", withdrawFee: "0", withdrawMax: "1000" }] };
      },
      async _getEntrypointNetwork(chainId: number, token: string) {
        return token === "USDC" && chainId === CHAIN_IDs.OPTIMISM ? CHAIN_IDs.MAINNET : chainId;
      },
      _convertSourceToDestination: convertSourceToDestinationStub,
    };

    const economics = await estimateEdgeEconomics(candidate, {
      baseSigner: {} as never,
      cumulativeBalancesByLogicalAsset: { USDC: toBNWei("0"), USDT: toBNWei("0"), WETH: toBNWei("0") },
      logger: buildNoopLogger(),
      pricingContext: buildMockPricingContext(),
      rebalancerAdapters: { binance: adapter, cctp: cctpAdapter } as never,
    });

    expect(economics.inputCapacityNative.toString()).to.equal(expectedExecutableCapacityNative.toString());
    expect(convertSourceToDestinationStub.calledTwice).to.equal(true);
    expect(convertSourceToDestinationStub.firstCall.args[4].toString()).to.equal(sampledCapacityNative.toString());
    expect(convertSourceToDestinationStub.secondCall.args[4].toString()).to.equal(
      expectedExecutableCapacityNative.toString()
    );
  });

  it("quotes Binance destination bridge legs with converted destination-token amounts", async function () {
    const relayerConfig = buildRelayerConfig();
    const nodeContexts = materializeNodeDefinitions(buildManagedNodeTemplates(relayerConfig.inventoryConfig));
    const source = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.MAINNET && node.logicalAsset === "WETH",
      "Mainnet WETH"
    );
    const destination = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.HYPEREVM && node.logicalAsset === "USDT",
      "HyperEVM USDT"
    );
    const candidate = buildBinanceSwapCandidate(source, destination);
    const destinationBridgeAmount = toBNWei("2500", 6);
    const quotedBridgeAmounts: string[] = [];
    const convertSourceToDestinationStub = sinon.stub().resolves(destinationBridgeAmount);
    const quoteLiveOftRouteTransferStub = sinon
      .stub(jussiQuotes, "quoteLiveOftRouteTransfer")
      .callsFake(async (_quoteCandidate, amount) => {
        quotedBridgeAmounts.push(amount.toString());
        return {
          roundedInputSourceNative: amount,
          amountReceivedDestinationNative: amount,
          messageFeeAmount: toBNWei("0"),
          messageFeeIsNative: true,
          sendParamStruct: {} as never,
        };
      });
    const adapter = {
      async _getAccountCoins() {
        return { networkList: [{ name: "ETH", withdrawFee: "1" }] };
      },
      async _getEntrypointNetwork(chainId: number, token: string) {
        return token === "USDT" && chainId === CHAIN_IDs.HYPEREVM ? CHAIN_IDs.MAINNET : chainId;
      },
      _convertSourceToDestination: convertSourceToDestinationStub,
    };

    let economics: Awaited<ReturnType<typeof estimateEdgeEconomics>> | undefined;
    try {
      economics = await estimateEdgeEconomics(candidate, {
        baseSigner: {} as never,
        cumulativeBalancesByLogicalAsset: { USDC: toBNWei("0"), USDT: toBNWei("0"), WETH: toBNWei("0") },
        logger: buildNoopLogger(),
        pricingContext: buildMockPricingContext(),
        rebalancerAdapters: { binance: adapter } as never,
      });
    } finally {
      quoteLiveOftRouteTransferStub.restore();
    }

    expect(convertSourceToDestinationStub.calledOnce).to.equal(true);
    expect(convertSourceToDestinationStub.firstCall.args.slice(0, 4)).to.deep.equal([
      "WETH",
      CHAIN_IDs.MAINNET,
      "USDT",
      CHAIN_IDs.MAINNET,
    ]);
    expect(convertSourceToDestinationStub.firstCall.args[4].toString()).to.equal(toBNWei("100000", 18).toString());
    expect(economics?.inputCapacityNative.toString()).to.equal(toBNWei("1000000000", 18).toString());
    expect(quotedBridgeAmounts).to.deep.equal([destinationBridgeAmount.toString()]);
  });

  it("adds quoted bridge value fees to estimated gas costs", async function () {
    const relayerConfig = buildRelayerConfig();
    const nodeContexts = materializeNodeDefinitions(buildManagedNodeTemplates(relayerConfig.inventoryConfig));
    const source = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.MAINNET && node.logicalAsset === "WETH",
      "Mainnet WETH"
    );
    const destination = findExpectedNode(
      nodeContexts,
      (node) => node.chainId === CHAIN_IDs.BASE && node.logicalAsset === "WETH",
      "Base WETH"
    );
    const candidate: GraphEdgeCandidate = {
      family: "canonical",
      adapterOrBridgeName: "canonical",
      from: source,
      to: destination,
    };
    const breakdown = await estimateQuotedBridgeBreakdown(
      candidate,
      toBNWei("1"),
      {
        baseSigner: {} as never,
        pricingContext: {
          hubPoolChainId: CHAIN_IDs.MAINNET,
          deriveGasCostUsd: async () => 5,
        } as unknown as RuntimePricingContext,
      },
      "canonical",
      async () => 7
    );

    expect(breakdown.fixedCostUsd).to.equal(12);
  });

  it("uses quoteOFT output to finalize OFT quoteSend params before pricing the route", async function () {
    const quotedSendParams: Array<{ minAmountLD: { toString(): string } }> = [];
    const quoteSendPayInLzToken: boolean[] = [];
    const amount = toBNWei("1000", 6);
    const amountReceived = toBNWei("995", 6);
    const recipient = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]);
    const quote = await quoteOftRouteTransfer({
      reader: {
        async sharedDecimals() {
          return 6;
        },
        async quoteOFT(sendParamStruct) {
          quotedSendParams.push(sendParamStruct);
          return [{}, [], { amountReceivedLD: amountReceived }] as never;
        },
        async quoteSend(sendParamStruct, payInLzToken) {
          quotedSendParams.push(sendParamStruct);
          quoteSendPayInLzToken.push(payInLzToken);
          return { nativeFee: toBNWei("0.01"), lzTokenFee: "0" } as never;
        },
      },
      originChain: CHAIN_IDs.MAINNET,
      destinationChain: CHAIN_IDs.PLASMA,
      sourceDecimals: 6,
      recipient,
      amount,
    });

    expect(quotedSendParams).to.have.lengthOf(2);
    expect(quotedSendParams[0].minAmountLD.toString()).to.equal(amount.toString());
    expect(quotedSendParams[1].minAmountLD.toString()).to.equal(amountReceived.toString());
    expect(quote.sendParamStruct.minAmountLD.toString()).to.equal(amountReceived.toString());
    expect(quote.messageFeeIsNative).to.equal(true);
    expect(quote.messageFeeAssetAddress).to.equal(undefined);
    expect(quoteSendPayInLzToken).to.deep.equal([false]);
  });

  it("resolves legacy mesh OFT messengers when the origin chain is Tron", function () {
    const messenger = getMessengerEvm(
      EvmAddress.from(TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET]),
      CHAIN_IDs.TRON,
      CHAIN_IDs.MAINNET
    );

    expect(messenger.toNative().toLowerCase()).to.equal("0x3a08f76772e200653bb55c2a92998daca62e0e97");
  });

  it("uses MONAD receive options and fee-token pricing inputs for OFT routes on chains without native gas", async function () {
    const recipient = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]);
    const quoteSendPayInLzToken: boolean[] = [];
    const nativeFee = toBNWei("4", 9);
    const quote = await quoteOftRouteTransfer({
      reader: {
        async sharedDecimals() {
          return 6;
        },
        async quoteOFT() {
          return [{}, [], { amountReceivedLD: toBNWei("100", 6) }] as never;
        },
        async quoteSend(_sendParamStruct, payInLzToken) {
          quoteSendPayInLzToken.push(payInLzToken);
          return { nativeFee, lzTokenFee: toBNWei("7", 6) } as never;
        },
      },
      originChain: CHAIN_IDs.TEMPO,
      destinationChain: CHAIN_IDs.MONAD,
      sourceDecimals: 6,
      recipient,
      amount: toBNWei("100", 6),
    });

    expect(Array.from(quote.sendParamStruct.extraOptions as Uint8Array)).to.deep.equal(
      Array.from(resolveOftQuoteExtraOptions(CHAIN_IDs.MONAD) as Uint8Array)
    );
    expect(quote.messageFeeIsNative).to.equal(false);
    expect(quote.messageFeeAssetAddress.toLowerCase()).to.equal(
      resolveOftQuoteSendFeeAsset(CHAIN_IDs.TEMPO).toLowerCase()
    );
    expect(quote.messageFeeAmount.toString()).to.equal(nativeFee.toString());
    expect(quoteSendPayInLzToken).to.deep.equal([false]);
  });

  it("serializes graph envelopes and graph ids in the script output shape", async function () {
    const graphId = buildJussiGraphId(new Date("2026-04-01T09:10:11.000Z"));
    const graph = {
      graphId,
      rate_limit_buckets: [],
      payload: {
        latency_annualized_cost_rate: "0.05",
        pain_model: {
          surplus_annualized_cost_rate: "0.000219",
          deficit_annualized_cost_rate: "0.002055",
          out_of_band_severity_multiplier: "4.0",
        },
        logical_assets: {
          USDC: { decimals_by_chain: { "1": 6, "10": 6 } },
          USDT: { decimals_by_chain: { "1": 6 } },
          WETH: { decimals_by_chain: { "1": 18 } },
        },
        cumulative_balance_pain: {
          USDC: {
            target_balance_native: "1000000",
            min_threshold_native: "900000",
            max_threshold_native: "1100000",
            surplus_annualized_cost_rate: "0.000219",
            deficit_annualized_cost_rate: "0.002055",
            out_of_band_severity_multiplier: "4.0",
          },
          USDT: {
            target_balance_native: "1000000",
            min_threshold_native: "900000",
            max_threshold_native: "1100000",
            surplus_annualized_cost_rate: "0.000219",
            deficit_annualized_cost_rate: "0.002055",
            out_of_band_severity_multiplier: "4.0",
          },
          WETH: {
            target_balance_native: "1000000000000000000",
            min_threshold_native: "950000000000000000",
            max_threshold_native: "1050000000000000000",
            surplus_annualized_cost_rate: "0.000219",
            deficit_annualized_cost_rate: "0.002055",
            out_of_band_severity_multiplier: "8.0",
          },
        },
        edge_classes: [],
        nodes: [],
        edges: [],
      },
    };
    const envelope = buildJussiGraphEnvelope(graph);
    const graphJson = buildJussiGraphJson(graph);
    const bundleJson = buildJussiGraphBundleJson(graph);
    const rateLimitBucketsJson = buildJussiRateLimitBucketsJson(graph);

    expect(graphId).to.equal("usdc-usdt-weth-20260401T091011Z");
    expect(envelope).to.deep.equal({
      graph_id: graphId,
      payload: {
        graph: {
          latency_annualized_cost_rate: "0.05",
          pain_model: graph.payload.pain_model,
          logical_assets: graph.payload.logical_assets,
          cumulative_balance_pain: graph.payload.cumulative_balance_pain,
          edge_classes: [],
          nodes: [],
          edges: [],
        },
        rate_limit_buckets: [],
      },
    });
    expect(graphJson).to.deep.equal({
      latency_annualized_cost_rate: "0.05",
      pain_model: graph.payload.pain_model,
      logical_assets: graph.payload.logical_assets,
      cumulative_balance_pain: graph.payload.cumulative_balance_pain,
      edge_classes: [],
      nodes: [],
      edges: [],
    });
    expect(bundleJson).to.deep.equal({
      graph: graphJson,
      rate_limit_buckets: [],
    });
    expect(rateLimitBucketsJson).to.deep.equal({
      rate_limit_buckets: [],
    });
    expect(Object.keys(envelope)).to.deep.equal(["graph_id", "payload"]);
  });

  it("serializes prepared topology as a deterministic artifact", async function () {
    const prepared = await prepareGraphTopology({
      relayerConfig: buildRelayerConfig(),
      rebalancerConfig: buildRebalancerConfig(),
    });
    const artifact = buildJussiTopologyArtifact(prepared);
    const rebuiltArtifact = buildJussiTopologyArtifact(prepared);

    expect(artifact.node_count).to.equal(prepared.topology.nodeContexts.length);
    expect(artifact.edge_candidate_count).to.equal(prepared.topology.edgeCandidates.length);
    expect(artifact.rebalance_route_count).to.equal(prepared.rebalanceRoutes.length);
    expect(Object.keys(artifact).sort()).to.deep.equal(
      [
        "edge_candidate_count",
        "edge_candidates",
        "hub_pool_chain_id",
        "logical_assets",
        "node_count",
        "nodes",
        "rate_limit_buckets",
        "rebalance_route_count",
        "rebalance_routes",
        "required_native_price_chains",
      ].sort()
    );
    expect(artifact.nodes.map((node) => node.node_key)).to.deep.equal(
      [...artifact.nodes.map((node) => node.node_key)].sort((left, right) => left.localeCompare(right))
    );
    expect(artifact.edge_candidates.map((edge) => edge.edge_id)).to.deep.equal(
      [...artifact.edge_candidates.map((edge) => edge.edge_id)].sort((left, right) => left.localeCompare(right))
    );
    expect(stableJsonStringify(artifact)).to.equal(stableJsonStringify(rebuiltArtifact));
  });

  it("includes every configured SameAsset route in prepared and runtime topology", async function () {
    const supportedRoutes = getSameAssetRebalanceRouteSupport();
    const relayerConfig = buildSameAssetRelayerConfig(supportedRoutes);
    const rebalancerConfig = buildSameAssetRebalancerConfig(supportedRoutes);
    const sameAssetRoutes = buildSameAssetRebalanceRoutes(rebalancerConfig);
    const prepared = await prepareGraphTopology({ relayerConfig, rebalancerConfig });
    const runtimeRoutes = resolveRuntimeRebalanceRoutes(prepared);
    const artifact = buildJussiTopologyArtifact(prepared);

    expect(supportedRoutes).not.to.have.lengthOf(0);
    expect(sameAssetRoutes).to.have.lengthOf(supportedRoutes.length);
    sameAssetRoutes.forEach((route) => {
      const sourceTokenInfo = getTokenInfoFromSymbol(route.sourceToken, route.sourceChain);
      const destinationTokenInfo = getTokenInfoFromSymbol(route.destinationToken, route.destinationChain);
      const sourceNodeKey = canonicalNodeKey(route.sourceChain, sourceTokenInfo.address.toNative());
      const destinationNodeKey = canonicalNodeKey(route.destinationChain, destinationTokenInfo.address.toNative());
      const expectedFamily =
        route.adapter === "binance" &&
        resolveBinanceCoinSymbol(route.sourceToken) === resolveBinanceCoinSymbol(route.destinationToken)
          ? "binance_cex_bridge"
          : route.adapter;

      expect(prepared.rebalanceRoutes.some((preparedRoute) => rebalanceRouteMatches(preparedRoute, route))).to.equal(
        true
      );
      expect(runtimeRoutes.some((runtimeRoute) => rebalanceRouteMatches(runtimeRoute, route))).to.equal(true);
      expect(prepared.topology.nodeContexts.some((node) => node.nodeKey === sourceNodeKey)).to.equal(true);
      expect(prepared.topology.nodeContexts.some((node) => node.nodeKey === destinationNodeKey)).to.equal(true);

      const candidate = findExpectedEdge(
        prepared.topology.edgeCandidates,
        (edge) =>
          edge.from.nodeKey === sourceNodeKey &&
          edge.to.nodeKey === destinationNodeKey &&
          edge.rebalanceRoute !== undefined &&
          rebalanceRouteMatches(edge.rebalanceRoute, route),
        `${route.adapter}:${route.sourceToken}:${route.sourceChain}->${route.destinationToken}:${route.destinationChain}`
      );
      expect(candidate.family).to.equal(expectedFamily);
      expect(candidate.adapterOrBridgeName).to.equal(route.adapter);

      const artifactCandidate = artifact.edge_candidates.find(
        (edge) =>
          edge.from_node_key === sourceNodeKey &&
          edge.to_node_key === destinationNodeKey &&
          edge.rebalance_route?.source_chain === route.sourceChain &&
          edge.rebalance_route.source_token === route.sourceToken &&
          edge.rebalance_route.destination_chain === route.destinationChain &&
          edge.rebalance_route.destination_token === route.destinationToken &&
          edge.rebalance_route.adapter === route.adapter
      );
      expect(artifactCandidate, `missing topology artifact edge for ${route.sourceToken} on ${route.destinationChain}`)
        .to.exist;
      expect(artifactCandidate?.family).to.equal(expectedFamily);
      expect(artifactCandidate?.adapter_or_bridge_name).to.equal(route.adapter);
      if (expectedFamily === "binance" || expectedFamily === "binance_cex_bridge") {
        expect(artifactCandidate?.rate_limit_bucket_id).to.equal(BINANCE_RATE_LIMIT_BUCKET_ID);
        expect(
          artifact.rate_limit_buckets.some((bucket) => bucket.bucket_id === BINANCE_RATE_LIMIT_BUCKET_ID)
        ).to.equal(true);
      } else {
        expect(artifactCandidate?.rate_limit_bucket_id).to.equal(undefined);
      }
    });
  });

  it("rejects a configured SameAsset route when its managed inventory endpoint is missing", async function () {
    const supportedRoutes = getSameAssetRebalanceRouteSupport();
    const configuredRoutes = buildSameAssetRebalanceRoutes(buildSameAssetRebalancerConfig(supportedRoutes));
    const missingRoute = configuredRoutes[0];

    expect(missingRoute).not.to.equal(undefined);
    const missingEndpoint = { token: missingRoute.destinationToken, chainId: missingRoute.destinationChain };
    let errorMessage = "";
    try {
      await prepareGraphTopology({
        relayerConfig: buildSameAssetRelayerConfig(supportedRoutes, missingEndpoint),
        rebalancerConfig: buildSameAssetRebalancerConfig(supportedRoutes),
      });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).to.contain("destination");
    expect(errorMessage).to.contain(missingEndpoint.token);
    expect(errorMessage).to.contain(String(missingRoute.sourceChain));
    expect(errorMessage).to.contain(String(missingEndpoint.chainId));
  });

  it("excludes legacy mesh OFT routes from Jussi topology while keeping direct Binance Tron routes", async function () {
    const relayerConfig = new RelayerConfig({
      HUB_CHAIN_ID: String(CHAIN_IDs.MAINNET),
      RELAYER_INVENTORY_CONFIG: JSON.stringify({
        tokenConfig: {
          USDT: {
            [CHAIN_IDs.TRON]: { targetPct: 5, thresholdPct: 2 },
          },
        },
        wrapEtherTarget: "0",
        wrapEtherTargetPerChain: {},
        wrapEtherThreshold: "0",
        wrapEtherThresholdPerChain: {},
      }),
    });
    const rebalancerConfig = new RebalancerConfig({
      HUB_CHAIN_ID: String(CHAIN_IDs.MAINNET),
      REBALANCER_CONFIG: JSON.stringify({
        cumulativeTargetBalances: {
          USDT: {
            targetBalance: "100",
            thresholdBalance: "50",
            priorityTier: 0,
            chains: {
              [CHAIN_IDs.MAINNET]: 0,
              [CHAIN_IDs.TRON]: 0,
            },
          },
        },
        maxAmountsToTransfer: {},
        maxPendingOrders: {},
      }),
    });
    const prepared = await prepareGraphTopology({ relayerConfig, rebalancerConfig });
    const hasTronOftRoute = (route: {
      sourceChain: number;
      destinationChain: number;
      sourceToken: string;
      destinationToken: string;
      adapter: string;
    }) =>
      route.adapter === "oft" &&
      route.sourceToken === "USDT" &&
      route.destinationToken === "USDT" &&
      (route.sourceChain === CHAIN_IDs.TRON || route.destinationChain === CHAIN_IDs.TRON);
    const hasTronOftEdge = (edge: GraphEdgeCandidate) =>
      edge.family === "oft" &&
      edge.from.logicalAsset === "USDT" &&
      edge.to.logicalAsset === "USDT" &&
      (edge.from.chainId === CHAIN_IDs.TRON || edge.to.chainId === CHAIN_IDs.TRON);
    const hasTronBinanceEdge = (edge: GraphEdgeCandidate) =>
      edge.family === "binance_cex_bridge" &&
      edge.from.logicalAsset === "USDT" &&
      edge.to.logicalAsset === "USDT" &&
      (edge.from.chainId === CHAIN_IDs.TRON || edge.to.chainId === CHAIN_IDs.TRON);

    expect(prepared.rebalanceRoutes.some(hasTronOftRoute)).to.equal(false);
    expect(prepared.topology.edgeCandidates.some(hasTronOftEdge)).to.equal(false);
    expect(prepared.topology.edgeCandidates.some(hasTronBinanceEdge)).to.equal(true);
    expect(resolveRuntimeRebalanceRoutes(prepared).some(hasTronOftRoute)).to.equal(false);
  });

  it("initializes runtime adapters with bridge-derived prepared rebalance routes", async function () {
    const relayerConfig = buildRelayerConfig();
    const rebalancerConfig = buildRebalancerConfig();
    const prepared = await prepareGraphTopology({ relayerConfig, rebalancerConfig });
    const baseRoutes = buildRebalanceRoutes(rebalancerConfig);
    const routeKey = (route: {
      sourceChain: number;
      destinationChain: number;
      sourceToken: string;
      destinationToken: string;
      adapter: string;
    }) =>
      `${route.adapter}:${route.sourceToken}:${route.sourceChain}->${route.destinationToken}:${route.destinationChain}`;
    const baseRouteKeys = new Set(baseRoutes.map(routeKey));

    expect(resolveRuntimeRebalanceRoutes(prepared)).to.equal(prepared.rebalanceRoutes);
    expect(prepared.rebalanceRoutes.some((route) => !baseRouteKeys.has(routeKey(route)))).to.equal(true);
  });

  it("keeps target-balance magnitude out of the topology artifact when the token remains configured", async function () {
    const hubCtx = { hubPoolChainId: CHAIN_IDs.MAINNET };
    const relayerConfig = buildRelayerConfig();
    const buildPreparedArtifact = (targetBalance: string) => {
      const rebalancerConfig = buildRebalancerConfig(targetBalance);
      const rebalanceRoutes = buildRebalanceRoutes(rebalancerConfig);
      return buildJussiTopologyArtifact({
        relayerConfig,
        rebalancerConfig,
        hubCtx,
        rebalanceRoutes,
        topology: buildTopology({ relayerConfig, rebalanceRoutes, hubCtx }),
      });
    };

    expect(stableJsonStringify(buildPreparedArtifact("100"))).to.equal(stableJsonStringify(buildPreparedArtifact("0")));
    expect(buildRebalancerConfig("0").cumulativeTargetBalances.USDC.targetBalance.toString()).to.equal("0");
  });

  it("hashes graph bundles with canonical key ordering", async function () {
    const graph = buildMinimalGraph("test-graph");
    const bundle = buildJussiGraphBundleJson(graph);
    const reorderedBundle = {
      rate_limit_buckets: bundle.rate_limit_buckets,
      graph: {
        edges: bundle.graph.edges,
        nodes: bundle.graph.nodes,
        edge_classes: bundle.graph.edge_classes,
        cumulative_balance_pain: bundle.graph.cumulative_balance_pain,
        logical_assets: bundle.graph.logical_assets,
        pain_model: bundle.graph.pain_model,
        latency_annualized_cost_rate: bundle.graph.latency_annualized_cost_rate,
      },
    };

    expect(bundleHash(bundle)).to.match(/^[0-9a-f]{64}$/);
    expect(bundleHash(bundle)).to.equal(bundleHash(reorderedBundle));
  });

  it("PUTs graph bundles with bearer auth and accepts empty 2xx responses", async function () {
    const fetchStub = sinon.stub(globalThis, "fetch").resolves(new Response(null, { status: 204 }));
    try {
      const bundle = buildJussiGraphBundleJson(buildMinimalGraph("test-graph"));
      await new JussiApiClient("http://localhost:8080", "secret-token").putGraphBundle("test-graph", bundle);
      expect(fetchStub.calledOnce).to.equal(true);
      expect(fetchStub.firstCall.args[0]).to.equal("http://localhost:8080/graph_bundles/test-graph");
      expect(fetchStub.firstCall.args[1]?.method).to.equal("PUT");
      expect((fetchStub.firstCall.args[1]?.headers as Record<string, string>).Authorization).to.equal(
        "Bearer secret-token"
      );
      expect(fetchStub.firstCall.args[1]?.body).to.equal(JSON.stringify(bundle));
    } finally {
      fetchStub.restore();
    }
  });

  it("throws PUT status information on non-2xx responses", async function () {
    const fetchStub = sinon.stub(globalThis, "fetch").resolves(new Response("not allowed", { status: 403 }));
    try {
      let errorMessage = "";
      try {
        await putJsonWithTimeout("http://localhost:8080/graph_bundles/test", {}, {}, 1_000);
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
      expect(errorMessage).to.contain("status 403");
      expect(errorMessage).to.contain("not allowed");
    } finally {
      fetchStub.restore();
    }
  });

  it("validates upload targets without a signer", async function () {
    expect(validateJussiUploadEnv({ JUSSI_API_URL: "http://localhost:8080" }).hostname).to.equal("localhost");
    expect(
      validateJussiUploadEnv({
        JUSSI_API_URL: "https://jussi.example.com",
        JUSSI_ALLOW_PROD_UPLOAD: "true",
      }).hostname
    ).to.equal("jussi.example.com");

    let errorMessage = "";
    try {
      validateJussiUploadEnv({ JUSSI_API_URL: "https://jussi.example.com" });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    expect(errorMessage).to.contain("JUSSI_ALLOW_PROD_UPLOAD=true");
  });

  it("publishes under a token-checked Redis lock and persists no-TTL metadata", async function () {
    const redis = new InMemoryJussiRedis();
    const apiClient = { putGraphBundle: sinon.stub().resolves() } as unknown as JussiApiClient;
    const runFullBuildStub = sinon.stub().callsFake(async (graphId: string) => buildMinimalGraph(graphId));
    const now = () => new Date("2026-04-01T09:10:11.000Z");
    const publisher = new JussiGraphPublisher({
      apiClient,
      logger: buildNoopLogger(),
      redis,
      runFullBuild: runFullBuildStub,
      lockTtlMs: 1_000,
      now,
    });

    const result = await publisher.publishUpload();
    const lastPublishedRaw = await redis.get<string>(JUSSI_LAST_PUBLISHED_KEY);
    const lastPublished = JSON.parse(requireString(lastPublishedRaw, JUSSI_LAST_PUBLISHED_KEY));

    expect(result.uploaded).to.equal(true);
    expect(result.graphId).to.equal("usdc-usdt-weth-20260401T091011Z");
    expect(runFullBuildStub.calledOnceWith(result.graphId)).to.equal(true);
    expect((apiClient.putGraphBundle as sinon.SinonStub).calledOnce).to.equal(true);
    expect(await redis.ttl(JUSSI_LAST_PUBLISHED_KEY)).to.equal(-1);
    expect(Object.keys(lastPublished).sort()).to.deep.equal(["bundleHash", "graphId", "publishedAt"].sort());
    expect(lastPublished.graphId).to.equal(result.graphId);
    expect(lastPublished.bundleHash).to.equal(result.bundleHash);
    expect(lastPublished.publishedAt).to.equal("2026-04-01T09:10:11.000Z");
    expect(await redis.get(JUSSI_PUBLISH_LOCK_KEY)).to.equal(undefined);
  });

  it("does not PUT when the final upload lock renewal fails", async function () {
    const redis = new RenewFailingJussiRedis();
    const apiClient = { putGraphBundle: sinon.stub().resolves() } as unknown as JussiApiClient;
    const runFullBuildStub = sinon.stub().callsFake(async (graphId: string) => buildMinimalGraph(graphId));
    const publisher = new JussiGraphPublisher({
      apiClient,
      logger: buildNoopLogger(),
      redis,
      runFullBuild: runFullBuildStub,
      lockTtlMs: 60_000,
      now: () => new Date("2026-04-01T09:10:11.000Z"),
    });

    let errorMessage = "";
    try {
      await publisher.publishUpload();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).to.contain(`Lost ${JUSSI_PUBLISH_LOCK_KEY}`);
    expect(runFullBuildStub.calledOnce).to.equal(true);
    expect(redis.renewCalls).to.equal(1);
    expect((apiClient.putGraphBundle as sinon.SinonStub).called).to.equal(false);
  });

  it("does not persist metadata when the upload lock is lost after PUT", async function () {
    const redis = new SecondRenewFailingJussiRedis();
    const apiClient = { putGraphBundle: sinon.stub().resolves() } as unknown as JussiApiClient;
    const runFullBuildStub = sinon.stub().callsFake(async (graphId: string) => buildMinimalGraph(graphId));
    const publisher = new JussiGraphPublisher({
      apiClient,
      logger: buildNoopLogger(),
      redis,
      runFullBuild: runFullBuildStub,
      lockTtlMs: 60_000,
      now: () => new Date("2026-04-01T09:10:11.000Z"),
    });

    let errorMessage = "";
    try {
      await publisher.publishUpload();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).to.contain("Jussi upload metadata failure");
    expect(errorMessage).to.contain(`Lost ${JUSSI_PUBLISH_LOCK_KEY}`);
    expect(runFullBuildStub.calledOnce).to.equal(true);
    expect(redis.renewCalls).to.equal(2);
    expect((apiClient.putGraphBundle as sinon.SinonStub).calledOnce).to.equal(true);
    expect(await redis.get(JUSSI_LAST_PUBLISHED_KEY)).to.equal(undefined);
  });

  it("throws graph id and bundle hash when metadata persistence fails after PUT", async function () {
    const apiClient = { putGraphBundle: sinon.stub().resolves() } as unknown as JussiApiClient;
    const publisher = new JussiGraphPublisher({
      apiClient,
      logger: buildNoopLogger(),
      redis: new MetadataFailingJussiRedis(),
      runFullBuild: async (graphId) => buildMinimalGraph(graphId),
      now: () => new Date("2026-04-01T09:10:11.000Z"),
    });

    let errorMessage = "";
    try {
      await publisher.publishUpload();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).to.contain("graphId=usdc-usdt-weth-20260401T091011Z");
    expect(errorMessage).to.contain("bundleHash=");
    expect(errorMessage).to.contain("metadata write failed");
  });

  it("does not run the build or PUT when the upload lock is contended", async function () {
    const redis = new InMemoryJussiRedis();
    await redis.acquireLock(JUSSI_PUBLISH_LOCK_KEY, "other-token", 60_000);
    const apiClient = { putGraphBundle: sinon.stub().resolves() } as unknown as JussiApiClient;
    const runFullBuildStub = sinon.stub().resolves(buildMinimalGraph("unused"));
    const publisher = new JussiGraphPublisher({
      apiClient,
      logger: buildNoopLogger(),
      redis,
      runFullBuild: runFullBuildStub,
      lockTtlMs: 1_000,
    });

    let errorMessage = "";
    try {
      await publisher.publishUpload();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).to.contain("Could not acquire");
    expect(runFullBuildStub.called).to.equal(false);
    expect((apiClient.putGraphBundle as sinon.SinonStub).called).to.equal(false);
  });
});

import { expect, toBNWei } from "./utils";
import { CHAIN_IDs, EvmAddress, TOKEN_SYMBOLS_MAP } from "../src/utils";
import { RelayerConfig } from "../src/relayer/RelayerConfig";
import {
  GraphEdgeCandidate,
  buildJussiGraphBundleJson,
  buildBridgeEdgeCandidates,
  buildCumulativeBalancePainDefinitions,
  buildJussiGraphDefinition,
  buildLogicalAssetDefinitions,
  buildJussiGraphEnvelope,
  buildJussiGraphJson,
  buildJussiGraphId,
  buildJussiRateLimitBucketsJson,
  buildManagedNodeTemplates,
  dedupeGraphEdgeCandidates,
  materializeNodeDefinitions,
  quoteOftRouteTransfer,
  resolveBridgeLatencySeconds,
  resolveExchangeLatencySeconds,
  resolveGraphBridgeLatencySeconds,
  resolveOftQuoteExtraOptions,
  resolveOftQuoteSendFeeAsset,
  resolveOptionalTranslatedTokenAddress,
  resolveRequiredNativePriceChains,
} from "../src/jussi/buildGraph";

function buildRelayerConfig(): RelayerConfig {
  return new RelayerConfig({
    HUB_CHAIN_ID: String(CHAIN_IDs.MAINNET),
    RELAYER_INVENTORY_CONFIG: JSON.stringify({
      tokenConfig: {
        USDC: {
          USDC: {
            [CHAIN_IDs.OPTIMISM]: { targetPct: 8, thresholdPct: 4 },
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

describe("Jussi graph builder helpers", async function () {
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
    const optimismUsdc = nodeContexts.find(
      (node) => node.chainId === CHAIN_IDs.OPTIMISM && node.symbol === "USDC" && node.logicalAsset === "USDC"
    )!;
    const mainnetUsdc = nodeContexts.find(
      (node) => node.chainId === CHAIN_IDs.MAINNET && node.symbol === "USDC" && node.logicalAsset === "USDC"
    )!;
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

    const graph = await buildJussiGraphDefinition({
      logger: { info: () => undefined, debug: () => undefined } as never,
      baseSigner: {} as never,
      relayerConfig,
      inventoryClient: inventoryClient as never,
      rebalanceRoutes: [],
      rebalancerAdapters: {},
      graphId: "test-graph",
    });

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
  });

  it("splits graph native price coverage between aliases and explicit native request prices", async function () {
    const nodeContexts = materializeNodeDefinitions(buildManagedNodeTemplates(buildRelayerConfig().inventoryConfig));
    const logicalAssets = buildLogicalAssetDefinitions(nodeContexts);
    const aliasedChainIds = new Set(
      Object.values(logicalAssets).flatMap((definition) => (definition.native_price_alias_chain_ids ?? []).map(Number))
    );
    const requiredNativePriceChains = resolveRequiredNativePriceChains(logicalAssets, nodeContexts);
    const graphChainIds = [...new Set(nodeContexts.map((node) => node.chainId))].sort((a, b) => a - b);

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
  });

  it("discovers only direct token-splitter bridge candidates for pathUSD", async function () {
    const relayerConfig = buildRelayerConfig();
    const nodeContexts = materializeNodeDefinitions(buildManagedNodeTemplates(relayerConfig.inventoryConfig));
    const edgeCandidates = await buildBridgeEdgeCandidates(nodeContexts);

    const mainnetUsdc = nodeContexts.find(
      (node) => node.chainId === CHAIN_IDs.MAINNET && node.symbol === "USDC" && node.logicalAsset === "USDC"
    )!;
    const optimismUsdc = nodeContexts.find(
      (node) => node.chainId === CHAIN_IDs.OPTIMISM && node.symbol === "USDC" && node.logicalAsset === "USDC"
    )!;
    const tempoUsdc = nodeContexts.find((node) => node.chainId === CHAIN_IDs.TEMPO && node.symbol === "USDC.e")!;
    const pathUsd = nodeContexts.find((node) => node.chainId === CHAIN_IDs.TEMPO && node.symbol === "pathUSD")!;

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
    const mainnetUsdc = nodeContexts.find(
      (node) => node.chainId === CHAIN_IDs.MAINNET && node.symbol === "USDC" && node.logicalAsset === "USDC"
    )!;
    const pathUsd = nodeContexts.find((node) => node.chainId === CHAIN_IDs.TEMPO && node.symbol === "pathUSD")!;
    const hyperevmUsdt = nodeContexts.find((node) => node.chainId === CHAIN_IDs.HYPEREVM && node.symbol === "USDT")!;
    const optimismUsdc = nodeContexts.find((node) => node.chainId === CHAIN_IDs.OPTIMISM && node.symbol === "USDC")!;

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
    const bridgeCandidates = await buildBridgeEdgeCandidates(nodeContexts);
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

    const zoraToMainnet = bridgeCandidates.find(
      (candidate) =>
        candidate.from.chainId === CHAIN_IDs.ZORA &&
        candidate.to.chainId === CHAIN_IDs.MAINNET &&
        candidate.from.logicalAsset === "WETH"
    )!;
    const mainnetToZora = bridgeCandidates.find(
      (candidate) =>
        candidate.from.chainId === CHAIN_IDs.MAINNET &&
        candidate.to.chainId === CHAIN_IDs.ZORA &&
        candidate.from.logicalAsset === "WETH"
    )!;
    const plasmaToMainnet = bridgeCandidates.find(
      (candidate) =>
        candidate.from.chainId === CHAIN_IDs.PLASMA &&
        candidate.to.chainId === CHAIN_IDs.MAINNET &&
        candidate.from.logicalAsset === "WETH"
    )!;

    expect(resolveGraphBridgeLatencySeconds(zoraToMainnet)).to.equal(7 * 24 * 60 * 60);
    expect(resolveGraphBridgeLatencySeconds(mainnetToZora)).to.equal(20 * 60);
    expect(resolveGraphBridgeLatencySeconds(plasmaToMainnet)).to.equal(20 * 60);
    expect(
      resolveGraphBridgeLatencySeconds(bridgeCandidates.find((candidate) => candidate.family === "binance_cex_bridge")!)
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

  it("uses quoteOFT output to finalize OFT quoteSend params before pricing the route", async function () {
    const quotedSendParams: Array<{ minAmountLD: { toString(): string } }> = [];
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
        async quoteSend(sendParamStruct) {
          quotedSendParams.push(sendParamStruct);
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
  });

  it("uses MONAD receive options and fee-token pricing inputs for OFT routes on chains without native gas", async function () {
    const recipient = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]);
    const quote = await quoteOftRouteTransfer({
      reader: {
        async sharedDecimals() {
          return 6;
        },
        async quoteOFT() {
          return [{}, [], { amountReceivedLD: toBNWei("100", 6) }] as never;
        },
        async quoteSend() {
          return { nativeFee: toBNWei("4", 9), lzTokenFee: "0" } as never;
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
});

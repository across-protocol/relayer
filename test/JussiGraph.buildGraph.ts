import { expect, toBNWei } from "./utils";
import { CHAIN_IDs, EvmAddress, TOKEN_SYMBOLS_MAP } from "../src/utils";
import { RelayerConfig } from "../src/relayer/RelayerConfig";
import {
  GraphEdgeCandidate,
  buildAllowedSwapEdgeCandidates,
  buildJussiGraphEnvelope,
  buildJussiGraphId,
  buildManagedNodeTemplates,
  canonicalNodeKey,
  dedupeGraphEdgeCandidates,
  materializeNodeDefinitions,
  resolveBridgeLatencySeconds,
  resolveExchangeLatencySeconds,
  resolveOptionalTranslatedTokenAddress,
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
  it("extracts mainnet and aliased USDC/USDT node templates from synthetic inventory config", async function () {
    const relayerConfig = buildRelayerConfig();
    const templates = buildManagedNodeTemplates(relayerConfig.inventoryConfig, CHAIN_IDs.MAINNET);
    const hasNode = (chainId: number, symbol: string) =>
      templates.some((template) => template.chainId === chainId && template.symbol === symbol);

    expect(hasNode(CHAIN_IDs.MAINNET, "USDC")).to.equal(true);
    expect(hasNode(CHAIN_IDs.MAINNET, "USDT")).to.equal(true);
    expect(hasNode(CHAIN_IDs.OPTIMISM, "USDC")).to.equal(true);
    expect(hasNode(CHAIN_IDs.OPTIMISM, "USDC.e")).to.equal(true);
    expect(hasNode(CHAIN_IDs.BASE, "USDC")).to.equal(true);
    expect(hasNode(CHAIN_IDs.BASE, "USDbC")).to.equal(true);
    expect(hasNode(CHAIN_IDs.TEMPO, "USDC.e")).to.equal(true);
    expect(hasNode(CHAIN_IDs.TEMPO, "pathUSD")).to.equal(true);
    expect(hasNode(CHAIN_IDs.HYPEREVM, "USDT")).to.equal(true);
  });

  it("expands the configured pathUSD swap routes into direct graph edge requirements", async function () {
    const relayerConfig = buildRelayerConfig();
    const nodeContexts = materializeNodeDefinitions(buildManagedNodeTemplates(relayerConfig.inventoryConfig), {
      USDC: toBNWei("1000", 6),
      USDT: toBNWei("1000", 6),
    });
    const edgeCandidates = buildAllowedSwapEdgeCandidates(relayerConfig, nodeContexts);

    const mainnetUsdcNodeKey = canonicalNodeKey(
      CHAIN_IDs.MAINNET,
      nodeContexts.find((node) => node.chainId === CHAIN_IDs.MAINNET && node.logicalAsset === "USDC")!.tokenAddress
    );
    const pathUsdNodeKey = canonicalNodeKey(
      CHAIN_IDs.TEMPO,
      nodeContexts.find((node) => node.chainId === CHAIN_IDs.TEMPO && node.symbol === "pathUSD")!.tokenAddress
    );

    expect(
      edgeCandidates.some((edge) => edge.from.nodeKey === mainnetUsdcNodeKey && edge.to.nodeKey === pathUsdNodeKey)
    ).to.equal(true);
    expect(
      edgeCandidates.some((edge) => edge.from.nodeKey === pathUsdNodeKey && edge.to.nodeKey === mainnetUsdcNodeKey)
    ).to.equal(true);
  });

  it("dedupes identical edges while preserving parallel adapters", async function () {
    const relayerConfig = buildRelayerConfig();
    const nodeContexts = materializeNodeDefinitions(buildManagedNodeTemplates(relayerConfig.inventoryConfig), {
      USDC: toBNWei("1000", 6),
      USDT: toBNWei("1000", 6),
    });
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

    expect(deduped).to.have.lengthOf(3);
    expect(deduped.filter((candidate) => candidate.from.nodeKey === hyperevmUsdt.nodeKey)).to.have.lengthOf(2);
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
    expect(
      resolveExchangeLatencySeconds({ family: "hyperliquid", sourceBridgeLatencySeconds: oftLatency })
    ).to.equal(1500);
    expect(
      resolveExchangeLatencySeconds({
        family: "binance",
        sourceBridgeLatencySeconds: cctpLatency,
        destinationBridgeLatencySeconds: slowOftLatency,
      })
    ).to.equal(41100);
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

  it("serializes graph envelopes and graph ids in the script output shape", async function () {
    const graphId = buildJussiGraphId(new Date("2026-04-01T09:10:11.000Z"));
    const envelope = buildJussiGraphEnvelope({
      graphId,
      payload: {
        nodes: [],
        edges: [],
      },
    });

    expect(graphId).to.equal("usdc-usdt-20260401T091011Z");
    expect(envelope).to.deep.equal({
      graph_id: graphId,
      payload: {
        nodes: [],
        edges: [],
      },
    });
    expect(Object.keys(envelope)).to.deep.equal(["graph_id", "payload"]);
  });
});

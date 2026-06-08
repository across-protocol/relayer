import dotenv from "dotenv";
dotenv.config();
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import util from "util";
import winston from "winston";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { waitForLogger } from "@risk-labs/logger";
import { getRedisCache } from "../src/cache/Redis";
import { updateSpokePoolClients } from "../src/common";
import { JussiApiClient } from "../src/jussi/JussiApiClient";
import { JussiGraphPublisher, validateJussiUploadEnv } from "../src/jussi/JussiGraphPublisher";
import {
  buildJussiGraphEnvelope,
  buildJussiGraphJson,
  buildJussiRateLimitBucketsJson,
  buildJussiTopologyArtifact,
  JUSSI_LOGICAL_ASSETS,
  JussiGraphJson,
  LogicalAsset,
  PreparedGraphTopology,
  prepareGraphTopology,
  runFullBuild,
  stableJsonStringify,
} from "../src/jussi/buildGraph";
import { RelayerConfig } from "../src/relayer/RelayerConfig";
import { constructRelayerClients } from "../src/relayer/RelayerClientHelper";
import { RebalancerConfig } from "../src/rebalancer/RebalancerConfig";
import { constructCumulativeBalanceRebalancerClient } from "../src/rebalancer/RebalancerClientHelper";
import { retrieveSignerFromCLIArgs } from "../src/utils/CLIUtils";
import { PriceClient, acrossApi, chainIsSvm, coingecko, delay, defiLlama } from "../src/utils/SDKUtils";
import { getNativeTokenInfoForChain } from "../src/utils/TokenUtils";
import { isDefined } from "../src/utils/TypeGuards";
import { disconnectRedisClients } from "../src/utils/Redis";

const GRAPH_JSON_OUT_ENV = "JUSSI_GRAPH_JSON_OUT";
const RATE_LIMIT_BUCKETS_JSON_OUT_ENV = "JUSSI_RATE_LIMIT_BUCKETS_JSON_OUT";
const PRICES_BY_ASSET_JSON_OUT_ENV = "JUSSI_PRICES_BY_ASSET_JSON_OUT";
const TOPOLOGY_JSON_OUT_ENV = "JUSSI_TOPOLOGY_JSON_OUT";
const TOPOLOGY_JSON_IN_ENV = "JUSSI_TOPOLOGY_JSON_IN";
const DEFAULT_TOPOLOGY_ARTIFACT_PATH = "src/jussi/graphs/sampleTopology.json";

export type BuildJussiGraphFlags = {
  check: boolean;
  topologyOnly: boolean;
  upload: boolean;
};

export function parseBuildJussiGraphFlags(args: string[]): BuildJussiGraphFlags {
  const flags: BuildJussiGraphFlags = { check: false, topologyOnly: false, upload: false };
  for (const arg of args) {
    if (arg === "--check") {
      flags.check = true;
    } else if (arg === "--topology-only") {
      flags.topologyOnly = true;
    } else if (arg === "--upload") {
      flags.upload = true;
    }
  }
  if (flags.check && !flags.topologyOnly) {
    throw new Error("--check requires --topology-only");
  }
  if (flags.topologyOnly && flags.upload) {
    throw new Error("--topology-only and --upload are mutually exclusive");
  }
  return flags;
}

function createScriptLogger(): winston.Logger {
  return winston.createLogger({
    level: process.env.LOG_LEVEL ?? "warn",
    format: winston.format.json(),
    transports: [
      new winston.transports.Console({
        stderrLevels: ["error", "warn", "info", "debug"],
      }),
    ],
  });
}

function requireEnvironmentVariable(name: string): void {
  if (!process.env[name]) {
    throw new Error(`${name} must be set`);
  }
}

function syncRelayerChains(relayerConfig: RelayerConfig, chainIds: number[]): void {
  relayerConfig.relayerOriginChains.splice(0, relayerConfig.relayerOriginChains.length, ...chainIds);
  relayerConfig.relayerDestinationChains.splice(0, relayerConfig.relayerDestinationChains.length, ...chainIds);
}

function ensureGraphLogicalAssetsAreIncludedInRelayerTokens(): void {
  if (!process.env.RELAYER_TOKENS) {
    return;
  }

  const parsed = JSON.parse(process.env.RELAYER_TOKENS) as string[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return;
  }

  const requiredHubTokens = JUSSI_LOGICAL_ASSETS.map(
    (logicalAsset) => TOKEN_SYMBOLS_MAP[logicalAsset].addresses[CHAIN_IDs.MAINNET]
  );
  const mergedTokens = Array.from(
    new Map(
      [...parsed, ...requiredHubTokens]
        .filter((token): token is string => Boolean(token))
        .map((token) => [token.toLowerCase(), token])
    ).values()
  );

  process.env.RELAYER_TOKENS = JSON.stringify(mergedTokens);
}

async function writeJsonArtifact(filePath: string | undefined, value: unknown): Promise<void> {
  if (!filePath) {
    return;
  }

  const resolvedPath = resolve(filePath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJsonArtifact(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(filePath), "utf8"));
}

function defaultRateLimitBucketsArtifactPath(graphJsonPath: string | undefined): string | undefined {
  if (!graphJsonPath) {
    return undefined;
  }

  const resolvedGraphPath = resolve(graphJsonPath);
  const parsedPath = parse(resolvedGraphPath);
  const derivedFileName = parsedPath.name.endsWith("Graph")
    ? `${parsedPath.name.slice(0, -"Graph".length)}RateLimitBuckets${parsedPath.ext}`
    : `${parsedPath.name}.rateLimitBuckets${parsedPath.ext}`;
  return join(parsedPath.dir, derivedFileName);
}

function defaultPricesByAssetArtifactPath(graphJsonPath: string | undefined): string | undefined {
  if (!graphJsonPath) {
    return undefined;
  }

  const resolvedGraphPath = resolve(graphJsonPath);
  const parsedPath = parse(resolvedGraphPath);
  const derivedFileName = parsedPath.name.endsWith("Graph")
    ? `${parsedPath.name.slice(0, -"Graph".length)}Prices${parsedPath.ext}`
    : `${parsedPath.name}.prices${parsedPath.ext}`;
  return join(parsedPath.dir, derivedFileName);
}

function formatExampleUsdPrice(value: number): string {
  return value.toFixed(8).replace(/\.?0+$/, "");
}

function getAcrossApiHost(hubChainId: number): string {
  return process.env.ACROSS_API_HOST ?? (hubChainId === CHAIN_IDs.MAINNET ? "app.across.to" : "testnet.across.to");
}

async function buildPricesByAsset(
  graphJson: JussiGraphJson,
  logger: winston.Logger
): Promise<Record<string, string>> {
  const priceClient = new PriceClient(logger, [
    new acrossApi.PriceFeed({ host: getAcrossApiHost(CHAIN_IDs.MAINNET) }),
    new coingecko.PriceFeed({ apiKey: process.env.COINGECKO_PRO_API_KEY }),
    new defiLlama.PriceFeed(),
  ]);
  const pricesByAsset: Record<string, string> = {};

  for (const logicalAsset of Object.keys(graphJson.logical_assets).sort() as LogicalAsset[]) {
    const address = TOKEN_SYMBOLS_MAP[logicalAsset].addresses[CHAIN_IDs.MAINNET];
    const price = await priceClient.getPriceByAddress(address);
    pricesByAsset[`logical:${logicalAsset}`] = formatExampleUsdPrice(Number(price.price));
  }

  const chainIds = Array.from(new Set(graphJson.nodes.map((node) => node.chain_id))).sort((a, b) => a - b);
  for (const chainId of chainIds) {
    const nativeTokenInfo = getNativeTokenInfoForChain(chainId, CHAIN_IDs.MAINNET);
    const price = await priceClient.getPriceByAddress(nativeTokenInfo.address);
    pricesByAsset[`native:${chainId}`] = formatExampleUsdPrice(Number(price.price));
  }

  return pricesByAsset;
}

function printGasPriceDiagnostics(
  diagnostics: { chainId: number; gasPriceGwei: string; source: string }[] | undefined
): void {
  if (!diagnostics || diagnostics.length === 0) {
    return;
  }

  const lines = [
    "Resolved graph gas prices (gwei):",
    ...diagnostics.map(
      ({ chainId, gasPriceGwei, source }) => `  chain ${chainId}: ${gasPriceGwei} gwei (${source.replace(/_/g, " ")})`
    ),
  ];
  process.stderr.write(`${lines.join("\n")}\n`);
}

async function prepareGraphTopologyFromEnv(): Promise<PreparedGraphTopology> {
  requireEnvironmentVariable("RELAYER_EXTERNAL_INVENTORY_CONFIG");
  requireEnvironmentVariable("REBALANCER_EXTERNAL_CONFIG");

  ensureGraphLogicalAssetsAreIncludedInRelayerTokens();
  const relayerConfig = new RelayerConfig(process.env);
  const rebalancerConfig = new RebalancerConfig(process.env);
  syncRelayerChains(
    relayerConfig,
    rebalancerConfig.chainIds.filter((chainId) => !chainIsSvm(chainId))
  );

  return prepareGraphTopology({ relayerConfig, rebalancerConfig });
}

async function writeBuildArtifacts(
  graph: Awaited<ReturnType<typeof runFullBuild>>,
  logger: winston.Logger
): Promise<void> {
  const graphJsonOutPath = process.env[GRAPH_JSON_OUT_ENV];
  const rateLimitBucketsJsonOutPath =
    process.env[RATE_LIMIT_BUCKETS_JSON_OUT_ENV] ?? defaultRateLimitBucketsArtifactPath(graphJsonOutPath);
  const pricesByAssetJsonOutPath =
    process.env[PRICES_BY_ASSET_JSON_OUT_ENV] ?? defaultPricesByAssetArtifactPath(graphJsonOutPath);
  const graphJson = buildJussiGraphJson(graph);
  const pricesByAsset = await buildPricesByAsset(graphJson, logger);
  await Promise.all([
    writeJsonArtifact(graphJsonOutPath, graphJson),
    writeJsonArtifact(rateLimitBucketsJsonOutPath, buildJussiRateLimitBucketsJson(graph)),
    writeJsonArtifact(pricesByAssetJsonOutPath, pricesByAsset),
  ]);
  process.stdout.write(`${JSON.stringify(buildJussiGraphEnvelope(graph), null, 2)}\n`);
}

async function runPreparedFullBuild(
  prepared: PreparedGraphTopology,
  logger: winston.Logger,
  graphId?: string
): Promise<Awaited<ReturnType<typeof runFullBuild>>> {
  const baseSigner = await retrieveSignerFromCLIArgs();
  logger.debug({ at: "buildJussiGraph", message: "Constructing relayer clients" });
  const { inventoryClient, spokePoolClients, tokenClient } = await constructRelayerClients(
    logger,
    prepared.relayerConfig,
    baseSigner
  );

  await Promise.all([
    updateSpokePoolClients(spokePoolClients, [
      "FundsDeposited",
      "FilledRelay",
      "RelayedRootBundle",
      "ExecutedRelayerRefundRoot",
    ]),
    tokenClient.update(),
  ]);

  inventoryClient.setBundleData();
  await inventoryClient.update(prepared.rebalancerConfig.chainIds);

  const rebalancerClient = await constructCumulativeBalanceRebalancerClient(
    logger,
    baseSigner,
    prepared.rebalanceRoutes
  );
  const graph = await runFullBuild(prepared, {
    logger,
    baseSigner,
    inventoryClient,
    rebalancerAdapters: rebalancerClient.adapters,
    graphId,
  });
  printGasPriceDiagnostics(graph.gasPriceDiagnostics);
  await writeBuildArtifacts(graph, logger);
  return graph;
}

async function runTopologyOnly(prepared: PreparedGraphTopology, flags: BuildJussiGraphFlags): Promise<void> {
  if (flags.check) {
    await compareTopologyArtifact(prepared);
    return;
  }

  const artifact = buildJussiTopologyArtifact(prepared);
  await writeJsonArtifact(process.env[TOPOLOGY_JSON_OUT_ENV], artifact);
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
}

async function compareTopologyArtifact(prepared: PreparedGraphTopology): Promise<void> {
  const artifactPath = resolve(process.env[TOPOLOGY_JSON_IN_ENV] ?? DEFAULT_TOPOLOGY_ARTIFACT_PATH);
  const artifact = buildJussiTopologyArtifact(prepared);
  const committedArtifact = await readJsonArtifact(artifactPath);
  const matches = stableJsonStringify(artifact) === stableJsonStringify(committedArtifact);
  process.stdout.write(
    `${JSON.stringify(
      {
        artifactPath,
        matches,
      },
      null,
      2
    )}\n`
  );
  if (!matches) {
    throw new Error("Topology artifact does not match committed snapshot");
  }
}

async function run(flags: BuildJussiGraphFlags, logger: winston.Logger): Promise<void> {
  const uploadUrl = flags.upload ? validateJussiUploadEnv(process.env) : undefined;

  const prepared = await prepareGraphTopologyFromEnv();
  if (flags.topologyOnly) {
    await runTopologyOnly(prepared, flags);
    return;
  }

  if (!flags.upload) {
    await runPreparedFullBuild(prepared, logger);
    return;
  }

  const redis = await getRedisCache(logger);
  if (!isDefined(redis)) {
    throw new Error("Redis is required for --upload");
  }
  if (!isDefined(uploadUrl)) {
    throw new Error("JUSSI_API_URL must be set for --upload");
  }
  const publisher = new JussiGraphPublisher({
    apiClient: new JussiApiClient(uploadUrl.toString(), process.env.JUSSI_API_TOKEN),
    logger,
    redis,
    runFullBuild: (graphId) => runPreparedFullBuild(prepared, logger, graphId),
  });
  const result = await publisher.publishUpload();
  logger.debug({ at: "buildJussiGraph", message: "Uploaded Jussi graph bundle", ...result });
}

async function main(): Promise<void> {
  const logger = createScriptLogger();
  let exitCode = 0;
  try {
    await run(parseBuildJussiGraphFlags(process.argv.slice(2)), logger);
  } catch (error) {
    exitCode = 1;
    const message =
      error instanceof Error ? error.message : util.inspect(error, { depth: null, breakLength: Infinity });
    logger.error({
      at: "buildJussiGraph",
      message: "Process exited with error",
      error: message,
      stack: error instanceof Error ? error.stack : undefined,
    });
  } finally {
    await disconnectRedisClients(logger);
    await waitForLogger(logger as Parameters<typeof waitForLogger>[0]);
    await delay(1);
    // eslint-disable-next-line no-process-exit
    process.exit(exitCode);
  }
}

if (require.main === module) {
  void main();
}

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import util from "util";
import winston from "winston";
import { version } from "../package.json";
import { updateSpokePoolClients } from "../src/common";
import { buildJussiGraphEnvelope, buildJussiGraphJson, buildJussiRateLimitBucketsJson } from "../src/jussi/serialize";
import { JUSSI_LOGICAL_ASSETS } from "../src/jussi/constants";
import { JussiApiClient } from "../src/jussi/JussiApiClient";
import {
  compareTopologyFingerprintWithRedis,
  JussiGraphPublisher,
  validateJussiUploadEnv,
} from "../src/jussi/JussiGraphPublisher";
import { runFullBuild } from "../src/jussi/GraphBuilder";
import { prepareGraphTopology } from "../src/jussi/prepareGraphTopology";
import { JussiGraphJson, PreparedGraphTopology } from "../src/jussi/types";
import { getAcrossHost } from "../src/clients/AcrossAPIClient";
import { constructRelayerClients } from "../src/relayer/RelayerClientHelper";
import { RelayerConfig } from "../src/relayer/RelayerConfig";
import { constructCumulativeBalanceRebalancerClient } from "../src/rebalancer/RebalancerClientHelper";
import { RebalancerConfig } from "../src/rebalancer/RebalancerConfig";
import {
  CHAIN_IDs,
  PriceClient,
  TOKEN_SYMBOLS_MAP,
  acrossApi,
  chainIsSvm,
  coingecko,
  config,
  delay,
  defiLlama,
  disconnectRedisClients,
  getRedisCache,
  getNativeTokenInfoForChain,
  isDefined,
  retrieveSignerFromCLIArgs,
  waitForLogger,
} from "../src/utils";

const GRAPH_JSON_OUT_ENV = "JUSSI_GRAPH_JSON_OUT";
const RATE_LIMIT_BUCKETS_JSON_OUT_ENV = "JUSSI_RATE_LIMIT_BUCKETS_JSON_OUT";
const PRICES_BY_ASSET_JSON_OUT_ENV = "JUSSI_PRICES_BY_ASSET_JSON_OUT";

export type BuildJussiGraphFlags = {
  check: boolean;
  compareRedis: boolean;
  upload: boolean;
};

export function parseBuildJussiGraphFlags(args: string[]): BuildJussiGraphFlags {
  const flags: BuildJussiGraphFlags = { check: false, compareRedis: false, upload: false };
  for (const arg of args) {
    if (arg === "--check") {
      flags.check = true;
    } else if (arg === "--compare-redis") {
      flags.compareRedis = true;
    } else if (arg === "--upload") {
      flags.upload = true;
    }
  }
  if (flags.compareRedis && !flags.check) {
    throw new Error("--compare-redis can only be used with --check");
  }
  if (flags.check && flags.upload) {
    throw new Error("--check and --upload are mutually exclusive");
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
  (relayerConfig.relayerOriginChains as number[]).splice(0, relayerConfig.relayerOriginChains.length, ...chainIds);
  (relayerConfig.relayerDestinationChains as number[]).splice(
    0,
    relayerConfig.relayerDestinationChains.length,
    ...chainIds
  );
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

async function buildExamplePricesByAsset(
  graphJson: JussiGraphJson,
  logger: winston.Logger
): Promise<Record<string, string>> {
  const priceClient = new PriceClient(logger, [
    new acrossApi.PriceFeed({ host: getAcrossHost(CHAIN_IDs.MAINNET) }),
    new coingecko.PriceFeed({ apiKey: process.env.COINGECKO_PRO_API_KEY }),
    new defiLlama.PriceFeed(),
  ]);
  const pricesByAsset: Record<string, string> = {};

  for (const logicalAsset of Object.keys(graphJson.logical_assets).sort()) {
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
  const examplePricesByAsset = await buildExamplePricesByAsset(graphJson, logger);
  await Promise.all([
    writeJsonArtifact(graphJsonOutPath, graphJson),
    writeJsonArtifact(rateLimitBucketsJsonOutPath, buildJussiRateLimitBucketsJson(graph)),
    writeJsonArtifact(pricesByAssetJsonOutPath, examplePricesByAsset),
  ]);
  process.stdout.write(`${JSON.stringify(buildJussiGraphEnvelope(graph), null, 2)}\n`);
}

async function runPreparedFullBuild(
  prepared: PreparedGraphTopology,
  logger: winston.Logger,
  graphId?: string
): Promise<Awaited<ReturnType<typeof runFullBuild>>> {
  const baseSigner = await retrieveSignerFromCLIArgs();
  logger.info({ at: "buildJussiGraph", message: "Constructing relayer clients" });
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

async function runCheck(prepared: PreparedGraphTopology, logger: winston.Logger, compareRedis: boolean): Promise<void> {
  if (!compareRedis) {
    process.stdout.write(`${prepared.topologyFingerprint}\n`);
    return;
  }
  const redis = await getRedisCache(logger);
  if (!isDefined(redis)) {
    throw new Error("Redis is required for --check --compare-redis");
  }
  const comparison = await compareTopologyFingerprintWithRedis(redis, prepared.topologyFingerprint);
  process.stdout.write(
    `${JSON.stringify(
      {
        topologyFingerprint: prepared.topologyFingerprint,
        publishedTopologyFingerprint: comparison.publishedTopologyFingerprint,
        matches: comparison.matches,
      },
      null,
      2
    )}\n`
  );
  if (!comparison.matches) {
    throw new Error("Topology fingerprint does not match Redis");
  }
}

async function run(flags: BuildJussiGraphFlags, logger: winston.Logger): Promise<void> {
  if (flags.upload) {
    validateJussiUploadEnv(process.env);
  }

  const prepared = await prepareGraphTopologyFromEnv();
  if (flags.check) {
    await runCheck(prepared, logger, flags.compareRedis);
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
  const publisher = new JussiGraphPublisher({
    apiClient: new JussiApiClient(process.env.JUSSI_API_URL!, process.env.JUSSI_API_TOKEN),
    logger,
    redis,
    runFullBuild: (graphId) => runPreparedFullBuild(prepared, logger, graphId),
  });
  const result = await publisher.publishUpload(prepared);
  logger.info({ at: "buildJussiGraph", message: "Uploaded Jussi graph bundle", ...result });
}

async function main(): Promise<void> {
  process.env.ACROSS_BOT_VERSION = version;
  config();

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

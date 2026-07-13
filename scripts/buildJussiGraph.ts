process.env.DOTENV_CONFIG_QUIET ??= "true";
import dotenv from "dotenv";
dotenv.config();
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { inspect, isDeepStrictEqual, parseArgs } from "node:util";
import winston from "winston";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { getRedisCache } from "../src/cache/Redis";
import { getAcrossHost } from "../src/clients/AcrossAPIClient";
import { updateSpokePoolClients } from "../src/common";
import { JussiApiClient } from "../src/jussi/JussiApiClient";
import { JussiGraphPublisher, validateJussiUploadEnv } from "../src/jussi/JussiGraphPublisher";
import {
  buildJussiGraphEnvelope,
  buildJussiTopologyArtifact,
  JUSSI_LOGICAL_ASSETS,
  JussiPutGraphRequest,
  LogicalAsset,
  PreparedGraphTopology,
  prepareGraphTopology,
  runFullBuild,
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

export type BuildJussiGraphFlags = {
  check: boolean;
  relayerAddress?: string;
  topologyOnly: boolean;
  upload: boolean;
};

export function parseBuildJussiGraphFlags(args: string[]): BuildJussiGraphFlags {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: {
      check: { type: "boolean", multiple: true },
      relayerAddress: { type: "string" },
      "topology-only": { type: "boolean", multiple: true },
      upload: { type: "boolean", multiple: true },
    },
  });
  if (values.relayerAddress === true) {
    throw new Error("--relayerAddress requires an address");
  }
  const enabled = (value: unknown): boolean => Array.isArray(value) && value.includes(true);
  const flags: BuildJussiGraphFlags = {
    check: enabled(values.check),
    ...(typeof values.relayerAddress === "string" ? { relayerAddress: values.relayerAddress } : {}),
    topologyOnly: enabled(values["topology-only"]),
    upload: enabled(values.upload),
  };
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

function defaultCompanionArtifactPath(graphJsonPath: string | undefined, artifactName: string): string | undefined {
  if (!graphJsonPath) {
    return undefined;
  }

  const resolvedGraphPath = resolve(graphJsonPath);
  const parsedPath = parse(resolvedGraphPath);
  const capitalizedArtifactName = `${artifactName[0].toUpperCase()}${artifactName.slice(1)}`;
  const derivedFileName = parsedPath.name.endsWith("Graph")
    ? `${parsedPath.name.slice(0, -"Graph".length)}${capitalizedArtifactName}${parsedPath.ext}`
    : `${parsedPath.name}.${artifactName}${parsedPath.ext}`;
  return join(parsedPath.dir, derivedFileName);
}

function formatExampleUsdPrice(value: number): string {
  return value.toFixed(8).replace(/\.?0+$/, "");
}

async function buildPricesByAsset(
  graphJson: JussiPutGraphRequest,
  requiredNativePriceChains: number[],
  logger: winston.Logger
): Promise<Record<string, string>> {
  const priceClient = new PriceClient(logger, [
    new acrossApi.PriceFeed({ host: getAcrossHost(CHAIN_IDs.MAINNET) }),
    new coingecko.PriceFeed({ apiKey: process.env.COINGECKO_PRO_API_KEY }),
    new defiLlama.PriceFeed(),
  ]);
  const pricesByAsset: Record<string, string> = {};

  for (const logicalAsset of Object.keys(graphJson.logical_assets).sort() as LogicalAsset[]) {
    const address = TOKEN_SYMBOLS_MAP[logicalAsset].addresses[CHAIN_IDs.MAINNET];
    const price = await priceClient.getPriceByAddress(address);
    pricesByAsset[`logical:${logicalAsset}`] = formatExampleUsdPrice(Number(price.price));
  }

  for (const chainId of requiredNativePriceChains) {
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
  for (const name of ["RELAYER_EXTERNAL_INVENTORY_CONFIG", "REBALANCER_EXTERNAL_CONFIG"]) {
    if (!process.env[name]) {
      throw new Error(`${name} must be set`);
    }
  }

  ensureGraphLogicalAssetsAreIncludedInRelayerTokens();
  const relayerConfig = new RelayerConfig(process.env);
  const rebalancerConfig = new RebalancerConfig(process.env);
  const evmChainIds = rebalancerConfig.chainIds.filter((chainId) => !chainIsSvm(chainId));
  relayerConfig.relayerOriginChains.splice(0, relayerConfig.relayerOriginChains.length, ...evmChainIds);
  relayerConfig.relayerDestinationChains.splice(0, relayerConfig.relayerDestinationChains.length, ...evmChainIds);

  return prepareGraphTopology({ relayerConfig, rebalancerConfig });
}

async function writeBuildArtifacts(
  graph: Awaited<ReturnType<typeof runFullBuild>>,
  requiredNativePriceChains: number[],
  logger: winston.Logger
): Promise<void> {
  const graphJsonOutPath = process.env.JUSSI_GRAPH_JSON_OUT;
  const rateLimitBucketsJsonOutPath =
    process.env.JUSSI_RATE_LIMIT_BUCKETS_JSON_OUT ?? defaultCompanionArtifactPath(graphJsonOutPath, "rateLimitBuckets");
  const pricesByAssetJsonOutPath =
    process.env.JUSSI_PRICES_BY_ASSET_JSON_OUT ?? defaultCompanionArtifactPath(graphJsonOutPath, "prices");
  const graphJson = graph.payload;
  await Promise.all([
    writeJsonArtifact(graphJsonOutPath, graphJson),
    writeJsonArtifact(rateLimitBucketsJsonOutPath, { rate_limit_buckets: graph.rate_limit_buckets }),
    ...(pricesByAssetJsonOutPath
      ? [
          buildPricesByAsset(graphJson, requiredNativePriceChains, logger).then((pricesByAsset) =>
            writeJsonArtifact(pricesByAssetJsonOutPath, pricesByAsset)
          ),
        ]
      : []),
  ]);
  process.stdout.write(`${JSON.stringify(buildJussiGraphEnvelope(graph), null, 2)}\n`);
}

async function runPreparedFullBuild(
  prepared: PreparedGraphTopology,
  logger: winston.Logger,
  relayerAddress?: string,
  graphId?: string
): Promise<Awaited<ReturnType<typeof runFullBuild>>> {
  const baseSigner = await retrieveSignerFromCLIArgs();
  logger.debug({ at: "buildJussiGraph", message: "Constructing relayer clients" });
  const { inventoryClient, spokePoolClients, tokenClient } = await constructRelayerClients(
    logger,
    prepared.relayerConfig,
    baseSigner,
    relayerAddress
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
  await writeBuildArtifacts(graph, prepared.topology.requiredNativePriceChains, logger);
  return graph;
}

async function runTopologyOnly(prepared: PreparedGraphTopology, flags: BuildJussiGraphFlags): Promise<void> {
  const artifact = buildJussiTopologyArtifact(prepared);
  if (flags.check) {
    const artifactPath = resolve(process.env.JUSSI_TOPOLOGY_JSON_IN ?? "src/jussi/graphs/sampleTopology.json");
    const committedArtifact = JSON.parse(await readFile(artifactPath, "utf8"));
    const matches = isDeepStrictEqual(artifact, committedArtifact);
    process.stdout.write(`${JSON.stringify({ artifactPath, matches }, null, 2)}\n`);
    if (!matches) {
      throw new Error("Topology artifact does not match committed snapshot");
    }
    return;
  }

  await writeJsonArtifact(process.env.JUSSI_TOPOLOGY_JSON_OUT, artifact);
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
}

async function run(flags: BuildJussiGraphFlags, logger: winston.Logger): Promise<void> {
  const uploadUrl = flags.upload ? validateJussiUploadEnv(process.env) : undefined;

  const prepared = await prepareGraphTopologyFromEnv();
  if (flags.topologyOnly) {
    await runTopologyOnly(prepared, flags);
    return;
  }

  if (!uploadUrl) {
    await runPreparedFullBuild(prepared, logger, flags.relayerAddress);
    return;
  }

  const redis = await getRedisCache(logger);
  if (!isDefined(redis)) {
    throw new Error("Redis is required for --upload");
  }
  const publisher = new JussiGraphPublisher({
    apiClient: new JussiApiClient(uploadUrl.toString(), process.env.JUSSI_API_TOKEN),
    logger,
    redis,
    runFullBuild: (graphId) => runPreparedFullBuild(prepared, logger, flags.relayerAddress, graphId),
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
    const message = error instanceof Error ? error.message : inspect(error, { depth: null, breakLength: Infinity });
    logger.error({
      at: "buildJussiGraph",
      message: "Process exited with error",
      error: message,
      stack: error instanceof Error ? error.stack : undefined,
    });
  } finally {
    await disconnectRedisClients(logger);
    await delay(1);
    // eslint-disable-next-line no-process-exit
    process.exit(exitCode);
  }
}

if (require.main === module) {
  void main();
}

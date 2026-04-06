import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import util from "util";
import winston from "winston";
import { version } from "../package.json";
import { updateSpokePoolClients } from "../src/common";
import {
  buildBridgeAdapterRoutes,
  buildJussiGraphDefinition,
  buildJussiGraphEnvelope,
  buildJussiGraphJson,
  buildManagedNodeTemplates,
  JUSSI_LOGICAL_ASSETS,
  materializeNodeDefinitions,
} from "../src/jussi/buildGraph";
import { constructRelayerClients } from "../src/relayer/RelayerClientHelper";
import { RelayerConfig } from "../src/relayer/RelayerConfig";
import { constructCumulativeBalanceRebalancerClient } from "../src/rebalancer/RebalancerClientHelper";
import { RebalancerConfig } from "../src/rebalancer/RebalancerConfig";
import { buildRebalanceRoutes } from "../src/rebalancer/buildRebalanceRoutes";
import {
  CHAIN_IDs,
  Signer,
  TOKEN_SYMBOLS_MAP,
  chainIsSvm,
  config,
  delay,
  disconnectRedisClients,
  retrieveSignerFromCLIArgs,
  waitForLogger,
} from "../src/utils";

const GRAPH_JSON_OUT_ENV = "JUSSI_GRAPH_JSON_OUT";

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

async function buildGraphRebalanceRoutes(
  _logger: winston.Logger,
  _baseSigner: Signer,
  relayerConfig: RelayerConfig,
  rebalancerConfig: RebalancerConfig
) {
  const nodeContexts = materializeNodeDefinitions(
    buildManagedNodeTemplates(relayerConfig.inventoryConfig, relayerConfig.hubPoolChainId).filter(
      (template) => !chainIsSvm(template.chainId)
    )
  );
  const bridgeAdapterRoutes = await buildBridgeAdapterRoutes({
    nodeContexts,
  });

  return [...buildRebalanceRoutes(rebalancerConfig), ...bridgeAdapterRoutes];
}

async function run(baseSigner: Signer, logger: winston.Logger): Promise<void> {
  requireEnvironmentVariable("RELAYER_EXTERNAL_INVENTORY_CONFIG");
  requireEnvironmentVariable("REBALANCER_EXTERNAL_CONFIG");

  ensureGraphLogicalAssetsAreIncludedInRelayerTokens();
  const relayerConfig = new RelayerConfig(process.env);
  const rebalancerConfig = new RebalancerConfig(process.env);
  syncRelayerChains(
    relayerConfig,
    rebalancerConfig.chainIds.filter((chainId) => !chainIsSvm(chainId))
  );

  try {
    logger.info({ at: "buildJussiGraph", message: "Constructing relayer clients" });
    const { inventoryClient, spokePoolClients, tokenClient } = await constructRelayerClients(
      logger,
      relayerConfig,
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
    await inventoryClient.update(rebalancerConfig.chainIds);

    const rebalanceRoutes = await buildGraphRebalanceRoutes(logger, baseSigner, relayerConfig, rebalancerConfig);
    const rebalancerClient = await constructCumulativeBalanceRebalancerClient(logger, baseSigner, rebalanceRoutes);
    const graph = await buildJussiGraphDefinition({
      logger,
      baseSigner,
      relayerConfig,
      inventoryClient,
      rebalanceRoutes,
      rebalancerAdapters: rebalancerClient.adapters,
    });

    await Promise.all([writeJsonArtifact(process.env[GRAPH_JSON_OUT_ENV], buildJussiGraphJson(graph))]);

    process.stdout.write(`${JSON.stringify(buildJussiGraphEnvelope(graph), null, 2)}\n`);
  } finally {
    await disconnectRedisClients(logger);
  }
}

async function main(): Promise<void> {
  process.env.ACROSS_BOT_VERSION = version;
  config();

  const logger = createScriptLogger();
  let exitCode = 0;
  try {
    await run(await retrieveSignerFromCLIArgs(), logger);
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
    await waitForLogger(logger as Parameters<typeof waitForLogger>[0]);
    await delay(1);
    // eslint-disable-next-line no-process-exit
    process.exit(exitCode);
  }
}

if (require.main === module) {
  void main();
}

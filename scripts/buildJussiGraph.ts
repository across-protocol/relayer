import winston from "winston";
import util from "util";
import { version } from "../package.json";
import { constructRelayerClients } from "../src/relayer/RelayerClientHelper";
import { RelayerConfig } from "../src/relayer/RelayerConfig";
import { RebalancerConfig } from "../src/rebalancer/RebalancerConfig";
import { buildRebalanceRoutes } from "../src/rebalancer/buildRebalanceRoutes";
import { constructCumulativeBalanceRebalancerClient } from "../src/rebalancer/RebalancerClientHelper";
import {
  buildBridgeAdapterRoutes,
  buildJussiGraphDefinition,
  buildJussiGraphEnvelope,
  buildManagedNodeTemplates,
  materializeNodeDefinitions,
} from "../src/jussi/buildGraph";
import { updateSpokePoolClients } from "../src/common";
import {
  Signer,
  bnZero,
  chainIsSvm,
  config,
  delay,
  disconnectRedisClients,
  retrieveSignerFromCLIArgs,
  waitForLogger,
} from "../src/utils";

function createScriptLogger(): winston.Logger {
  return winston.createLogger({
    level: process.env.LOG_LEVEL ?? "info",
    format: winston.format.json(),
    transports: [
      new winston.transports.Console({
        stderrLevels: ["error", "warn", "info", "debug"],
      }),
    ],
  });
}

async function run(baseSigner: Signer): Promise<void> {
  if (!process.env.RELAYER_EXTERNAL_INVENTORY_CONFIG) {
    throw new Error("RELAYER_EXTERNAL_INVENTORY_CONFIG must be set");
  }
  if (!process.env.REBALANCER_EXTERNAL_CONFIG) {
    throw new Error("REBALANCER_EXTERNAL_CONFIG must be set");
  }

  const logger = createScriptLogger();
  logger.info({
    at: "buildJussiGraph",
    message: "Starting graph generation script",
  });
  const relayerConfig = new RelayerConfig(process.env);
  const rebalancerConfig = new RebalancerConfig(process.env);
  const activeChainIds = rebalancerConfig.chainIds.filter((chainId) => !chainIsSvm(chainId));
  (relayerConfig.relayerOriginChains as number[]).splice(0, relayerConfig.relayerOriginChains.length, ...activeChainIds);
  (relayerConfig.relayerDestinationChains as number[]).splice(
    0,
    relayerConfig.relayerDestinationChains.length,
    ...activeChainIds
  );
  const rebalanceRoutes = buildRebalanceRoutes(rebalancerConfig);
  logger.info({
    at: "buildJussiGraph",
    message: "Constructing relayer clients",
  });
  const relayerClients = await constructRelayerClients(logger, relayerConfig, baseSigner);
  const { inventoryClient, spokePoolClients, tokenClient } = relayerClients;

  logger.info({
    at: "buildJussiGraph",
    message: "Updating spoke pool clients and token client",
  });
  await Promise.all([
    updateSpokePoolClients(spokePoolClients, [
      "FundsDeposited",
      "FilledRelay",
      "RelayedRootBundle",
      "ExecutedRelayerRefundRoot",
    ]),
    tokenClient.update(),
  ]);

  logger.info({
    at: "buildJussiGraph",
    message: "Refreshing inventory state",
    chainIds: rebalancerConfig.chainIds,
  });
  inventoryClient.setBundleData();
  await inventoryClient.update(rebalancerConfig.chainIds);

  logger.info({
    at: "buildJussiGraph",
    message: "Constructing cumulative balance rebalancer client",
  });
  const bridgeAdapterRoutes = await buildBridgeAdapterRoutes({
    logger,
    baseSigner,
    relayerConfig,
    nodeContexts: materializeNodeDefinitions(
      buildManagedNodeTemplates(relayerConfig.inventoryConfig).filter((template) => !chainIsSvm(template.chainId)),
      {
        USDC: bnZero,
        USDT: bnZero,
      }
    ),
  });
  const rebalancerClient = await constructCumulativeBalanceRebalancerClient(
    logger,
    baseSigner,
    dedupeRebalanceRoutes([...rebalanceRoutes, ...bridgeAdapterRoutes])
  );
  const graph = await buildJussiGraphDefinition({
    logger,
    baseSigner,
    relayerConfig,
    rebalancerConfig,
    inventoryClient,
    rebalanceRoutes,
    rebalancerAdapters: rebalancerClient.adapters,
  });

  logger.info({
    at: "buildJussiGraph",
    message: "Writing graph envelope to stdout",
    graphId: graph.graphId,
    nodeCount: graph.payload.nodes.length,
    edgeCount: graph.payload.edges.length,
  });
  process.stdout.write(JSON.stringify(buildJussiGraphEnvelope(graph), null, 2));

  await disconnectRedisClients(logger);
}

function dedupeRebalanceRoutes(rebalanceRoutes: ReturnType<typeof buildRebalanceRoutes>): ReturnType<typeof buildRebalanceRoutes> {
  const uniqueRoutes = new Map<string, (typeof rebalanceRoutes)[number]>();
  rebalanceRoutes.forEach((route) => {
    uniqueRoutes.set(
      [route.sourceChain, route.sourceToken, route.destinationChain, route.destinationToken, route.adapter].join("|"),
      route
    );
  });
  return Array.from(uniqueRoutes.values());
}

if (require.main === module) {
  process.env.ACROSS_BOT_VERSION = version;
  config();

  let logger: winston.Logger = createScriptLogger();
  let exitCode = 0;
  retrieveSignerFromCLIArgs()
    .then((baseSigner) => {
      logger = createScriptLogger();
      return run(baseSigner);
    })
    .catch((error) => {
      exitCode = 1;
      const message = error instanceof Error ? error.message : util.inspect(error, { depth: null, breakLength: Infinity });
      logger.error({
        at: "buildJussiGraph",
        message: "Process exited with error",
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
      });
    })
    .finally(async () => {
      await waitForLogger(logger as any);
      await delay(1);
      // eslint-disable-next-line no-process-exit
      process.exit(exitCode);
    });
}

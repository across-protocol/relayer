/**
 * Easy script to run UBA client on live production flow data. This script overrides the ConfigStoreClient
 * to pretend that the UBA was activated some time ago (configurable via UBA_ACTIVATION_BLOCK env var or defaults
 * to some time ~12 hours ago). It will log out all flows for all bundles over that time.
 *
 * All of the outflows will be "invalidated" because their realizedLpFeePct will not be equal to the expected
 * balancing fees, but all inflows should be added to the flow.
 *
 * Run with `ts-node ./src/scripts/testUBAClient.ts --wallet mnemonic`
 */
import {
  Wallet,
  winston,
  config,
  getSigner,
  Logger,
  getBlockForTimestamp,
  disconnectRedisClient,
  REDIS_URL,
} from "../utils";
import {
  constructSpokePoolClientsForFastDataworker,
  getSpokePoolClientEventSearchConfigsForFastDataworker,
} from "../dataworker/DataworkerClientHelper";
import { updateClients } from "../common";
import * as sdk from "@across-protocol/sdk-v2";
import { isDefined } from "@uma/financial-templates-lib/dist/types";
import { createDataworker } from "../dataworker";
import { RedisCache } from "../caching/RedisCache";

config();
let logger: winston.Logger;

export async function testUBAClient(_logger: winston.Logger, baseSigner: Wallet): Promise<void> {
  logger = _logger;

  // Override default config with sensible defaults:
  // - DATAWORKER_FAST_LOOKBACK_COUNT=8 balances limiting RPC requests with querying
  // enough data to limit # of excess historical deposit queries.
  // - SPOKE_ROOTS_LOOKBACK_COUNT unused in this script so set to something < DATAWORKER_FAST_LOOKBACK_COUNT
  // to avoid configuration error.
  process.env.DATAWORKER_FAST_LOOKBACK_COUNT = "16";
  process.env.SPOKE_ROOTS_LOOKBACK_COUNT = "1";
  const { clients, dataworker, config } = await createDataworker(_logger, baseSigner);
  await updateClients(clients);

  const { configStoreClient } = clients;
  let ubaActivationBlock: number;
  try {
    ubaActivationBlock = configStoreClient.getUBAActivationBlock();
    logger.debug({
      at: "UBAClientDemo",
      message: `UBA activation block is ${ubaActivationBlock}`,
      ubaActivationBundleStartBlocks: sdk.clients.getUbaActivationBundleStartBlocks(clients.hubPoolClient),
    });
  } catch (err) {
    logger.debug({
      at: "UBAClientDemo",
      message: `Error getting UBA activation block: ${err}`,
    });
  }

  // Create a mock config store client so we can inject a fake UBA activation block number to force the UBA client
  // to load UBA flows.
  if (!isDefined(ubaActivationBlock)) {
    // Allow caller to set a uba activation block or default to a recent bundle.
    const mockedUBAActivationBlock =
      Number(process.env.UBA_ACTIVATION_BLOCK) ||
      (await getBlockForTimestamp(1, Math.floor(Date.now() / 1000) - 12 * 60 * 60));
    const mockConfigStoreClient = new sdk.clients.mocks.MockConfigStoreClient(
      logger,
      configStoreClient.configStore,
      configStoreClient.eventSearchConfig,
      configStoreClient.configStoreVersion,
      undefined,
      undefined,
      configStoreClient.getEnabledChains()
    );
    mockConfigStoreClient.setUBAActivationBlock(mockedUBAActivationBlock);
    clients.configStoreClient = mockConfigStoreClient;
    clients.hubPoolClient.configStoreClient = mockConfigStoreClient;
  }
  await updateClients(clients);
  logger.debug({
    at: "UBAClientDemo",
    message: `Set UBA activation block to ${clients.configStoreClient.getUBAActivationBlock()}`,
  });

  // Now construct the spoke pool clients. We can use a "fast" setup here with limited lookback for each
  // spoke pool client because we have flat balancing fees and can use caching to avoid having to
  // fetch events from all time.
  const { fromBundle, toBundle, fromBlocks, toBlocks } = getSpokePoolClientEventSearchConfigsForFastDataworker(
    config,
    clients,
    dataworker
  );

  logger.debug({
    at: "UBAClientDemo",
    message:
      "Setting start blocks for SpokePoolClient equal to bundle evaluation end blocks from Nth latest valid root bundle",
    dataworkerFastLookbackCount: config.dataworkerFastLookbackCount,
    fromBlocks,
    toBlocks,
    fromBundleTxn: fromBundle?.transactionHash,
    toBundleTxn: toBundle?.transactionHash,
  });

  const spokePoolClients = await constructSpokePoolClientsForFastDataworker(
    logger,
    clients.hubPoolClient,
    config,
    baseSigner,
    fromBlocks,
    toBlocks
  );

  // Now, simply update the UBA client:
  const redisCache = new RedisCache(REDIS_URL);
  let successfullyInstantiated = false;
  try {
    await redisCache.instantiate();
    successfullyInstantiated = true;
  } catch (error) {
    logger.warn({
      at: "UBAClientDemo",
      message: "Failed to instantiate redis cache",
      error,
    });
  }
  const ubaClient = new sdk.clients.UBAClient(
    ["WETH", "USDC"],
    // clients.hubPoolClient.getL1Tokens().map((x) => x.symbol),
    clients.hubPoolClient,
    spokePoolClients,
    // Pass in no redis client for now as testing with fresh state is easier to reason about
    successfullyInstantiated ? new RedisCache(REDIS_URL) : undefined
  );
  await ubaClient.update();
}

export async function run(_logger: winston.Logger): Promise<void> {
  const baseSigner: Wallet = await getSigner();
  await testUBAClient(_logger, baseSigner);
  await disconnectRedisClient(logger);
}

// eslint-disable-next-line no-process-exit
run(Logger).then(async () => process.exit(0));

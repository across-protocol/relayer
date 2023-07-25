import { Wallet, winston, config, getSigner, Logger, getBlockForTimestamp, disconnectRedisClient } from "../utils";
import {
  constructSpokePoolClientsForFastDataworker,
  getSpokePoolClientEventSearchConfigsForFastDataworker,
} from "../dataworker/DataworkerClientHelper";
import { updateClients } from "../common";
import * as sdk from "@across-protocol/sdk-v2";
import { isDefined } from "@uma/financial-templates-lib/dist/types";
import { createDataworker } from "../dataworker";

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
  const { clients, dataworker, config } = await createDataworker(_logger, baseSigner);

  const { configStoreClient } = clients;
  await configStoreClient.update();
  const ubaActivationBlock = configStoreClient.getUBAActivationBlock();

  // Create a mock config store client so we can inject a fake UBA activation block number to force the UBA client
  // to load UBA flows.
  if (!isDefined(ubaActivationBlock)) {
    // Allow caller to set a uba activation block or default to a block on the hub pool chain from 6 hours ago.
    const mockedUBAActivationBlock =
      Number(process.env.UBA_ACTIVATION_BLOCK) ||
      (await getBlockForTimestamp(1, Math.floor(Date.now() / 1000) - 12 * 60 * 60));
    const mockConfigStoreClient = new sdk.clients.mocks.MockConfigStoreClient(
      logger,
      configStoreClient.configStore,
      configStoreClient.eventSearchConfig,
      configStoreClient.configStoreVersion,
      configStoreClient.enabledChainIds
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

  // Now construct the spoke pool clients:
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
  const ubaClient = new sdk.clients.UBAClient(
    ["USDC"],
    // clients.hubPoolClient.getL1Tokens().map((x) => x.symbol),
    clients.hubPoolClient,
    spokePoolClients
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

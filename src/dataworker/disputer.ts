import {
  winston,
  config,
  startupLogLevel,
  Signer,
  disconnectRedisClients,
} from "../utils";
import { createDataworker } from "./Dataworker";
import { DataworkerConfig } from "./DataworkerConfig";
import {
  constructSpokePoolClientsForFastDataworker,
  getSpokePoolClientEventSearchConfigsForFastDataworker,
} from "./DataworkerClientHelper";

config();
let logger: winston.Logger;

export async function runDataworker(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  logger = _logger;

  const config = new DataworkerConfig(process.env);
  const { clients, dataworker } = await createDataworker(logger, baseSigner, config);
  await config.update(logger);

  try {
    // Explicitly don't log addressFilter because it can be huge and can overwhelm log transports.
    const { addressFilter: _addressFilter, ...loggedConfig } = config;
    logger[startupLogLevel(config)]({ at: "Disputer", message: `Disputer 👩‍🔬`, loggedConfig });

    // Determine the spoke client's lookback:
    // 1. We initiate the spoke client event search windows based on a start bundle's bundle block end numbers and
    //    how many bundles we want to look back from the start bundle blocks.
    // 2. For example, if the start bundle is 100 and the lookback is 16, then we will set the spoke client event
    //    search window's toBlocks equal to the 100th bundle's block evaluation numbers and the fromBlocks equal
    //    to the 84th bundle's block evaluation numbers.
    // 3. Once we do all the querying, we figure out the earliest block that we’re able to validate per chain. This
    //    is simply equal to the first block queried per chain.
    // 4. If the earliest block we can validate is later than some target fully executed bundle's start blocks,
    //    then extend the SpokePoolClients' lookbacks and update again. Do this up to a specified # of retries.
    //    By dynamically increasing the range of Deposit events to at least cover the target bundle's
    //    start blocks, we can reduce the error rate. This is because of how the disputer and proposer will handle
    //    the case where it can't validate a fill without loading an earlier block.
    // 5. If the bundle we’re trying to validate or propose requires an earlier block, then exit early and
    //    emit an alert. In the dispute flow, this alert should be ERROR level.

    // Get block range for spoke clients using the dataworker fast lookback bundle count.
    const { fromBundle, toBundle, fromBlocks, toBlocks } = getSpokePoolClientEventSearchConfigsForFastDataworker(
      config,
      clients,
      dataworker
    );
    logger.debug({
      at: "Dataworker#index",
      message:
        "Setting start blocks for SpokePoolClient equal to bundle evaluation end blocks from Nth latest valid root bundle",
      dataworkerFastStartBundle: config.dataworkerFastStartBundle,
      dataworkerFastLookbackCount: config.dataworkerFastLookbackCount,
      fromBlocks,
      toBlocks,
      fromBundleTxn: fromBundle?.txnRef,
      toBundleTxn: toBundle?.txnRef,
    });
    const spokePoolClients = await constructSpokePoolClientsForFastDataworker(
      logger,
      clients.hubPoolClient,
      config,
      baseSigner,
      fromBlocks,
      toBlocks
    );

    // Validate and dispute pending proposal before proposing a new one
    await dataworker.validatePendingRootBundle(
      spokePoolClients,
      config.sendingTransactionsEnabled,
      fromBlocks,
      // @dev Opportunistically publish bundle data to external storage layer since we're reconstructing it in this
      // process, if user has configured it so.
      config.persistingBundleData
    );

    await clients.multiCallerClient.executeTxnQueues();

  } finally {
    await disconnectRedisClients(logger);
  }
}

import {
  processEndPollingLoop,
  winston,
  config,
  startupLogLevel,
  Wallet,
  getRedis,
  disconnectRedisClient,
} from "../utils";
import { spokePoolClientsToProviders, updateSpokePoolClients } from "../common";
import * as Constants from "../common";
import { Dataworker } from "./Dataworker";
import { DataworkerConfig } from "./DataworkerConfig";
import {
  constructDataworkerClients,
  updateDataworkerClients,
  constructSpokePoolClientsForFastDataworker,
  getSpokePoolClientEventSearchConfigsForFastDataworker,
} from "./DataworkerClientHelper";
import { BalanceAllocator } from "../clients/BalanceAllocator";
config();
let logger: winston.Logger;

export async function createDataworker(_logger: winston.Logger, baseSigner: Wallet) {
  const config = new DataworkerConfig(process.env);
  const clients = await constructDataworkerClients(_logger, config, baseSigner);

  const dataworker = new Dataworker(
    _logger,
    clients,
    Constants.CHAIN_ID_LIST_INDICES,
    config.maxRelayerRepaymentLeafSizeOverride,
    config.maxPoolRebalanceLeafSizeOverride,
    config.tokenTransferThresholdOverride,
    config.blockRangeEndBlockBuffer,
    config.spokeRootsLookbackCount,
    config.bufferToPropose
  );

  return {
    config,
    clients,
    dataworker,
  };
}
export async function runDataworker(_logger: winston.Logger, baseSigner: Wallet): Promise<void> {
  logger = _logger;
  const { clients, config, dataworker } = await createDataworker(logger, baseSigner);
  try {
    logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Dataworker started 👩‍🔬", config });

    for (;;) {
      const loopStart = Date.now();
      await updateDataworkerClients(clients);

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
        fromBundleTxn: fromBundle?.transactionHash,
        toBundleTxn: toBundle?.transactionHash,
      });
      const spokePoolClients = await constructSpokePoolClientsForFastDataworker(
        logger,
        clients.configStoreClient,
        config,
        baseSigner,
        fromBlocks,
        toBlocks
      );

      // Validate and dispute pending proposal before proposing a new one
      if (config.disputerEnabled)
        await dataworker.validatePendingRootBundle(spokePoolClients, config.sendingDisputesEnabled, fromBlocks);
      else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Disputer disabled" });

      if (config.proposerEnabled)
        await dataworker.proposeRootBundle(
          spokePoolClients,
          config.rootBundleExecutionThreshold,
          config.sendingProposalsEnabled,
          fromBlocks
        );
      else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Proposer disabled" });

      if (config.executorEnabled) {
        const balanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(spokePoolClients));

        // First, execute the mainnet pool rebalance leaf and mainnet spoke leaves because they should always
        // be atomically executable. Then, try to execute other pool rebalance leaves. This is an optimization
        // because the mainnet spoke leaves will return funds to Mainnet atomically that could make executing
        // other pool rebalance possible.
        const executablePoolRebalanceRoot = await dataworker.getExecutablePoolRebalanceLeaves(
          spokePoolClients,
          fromBlocks
        );

        // Either execute pool rebalance leaves or relayer refund leaves for non-Mainnet spoke pools.
        if (executablePoolRebalanceRoot) {
          const mainnetLeaf = executablePoolRebalanceRoot.unexecutedLeaves.find((leaf) => leaf.chainId === 1);
          if (mainnetLeaf) {
            await dataworker.executePoolRebalanceLeaves(
              [mainnetLeaf],
              executablePoolRebalanceRoot.expectedTrees,
              spokePoolClients,
              balanceAllocator,
              config.sendingExecutionsEnabled
            );

            // Simulate what the new balance would be like when added to the spoke pools. This will inform
            // executor as to which leaves it can execute. This is so we don't have to actually execute the pool
            // rebalance leaf before executing the other leaves. This way we can atomically execute
            // all mainnet leaves.
            mainnetLeaf.netSendAmounts.map(async (amount, index) => {
              const tokenForNetSendAmount = mainnetLeaf.l1Tokens[index];
              if (amount.gt(0))
                await balanceAllocator.addBalance(
                  1,
                  tokenForNetSendAmount,
                  spokePoolClients[1].spokePool.address,
                  amount
                );
            });

            // Update mainnet spoke pool clients with new roots:
            spokePoolClients[1].eventSearchConfig.toBlock =
              await spokePoolClients[1].spokePool.provider.getBlockNumber();
            await updateSpokePoolClients({ 1: spokePoolClients[1] }, ["RelayedRootBundle"]);

            // Only execute slow relays and relayer refunds for mainnet leaves. This should always be executable (if
            // there are any) if they are depending on funds to be sent from the HubPool after we execute the
            // pool rebalance leaf. Execute slow relays before relayer refunds to give them priority for any L2 funds.
            await dataworker.executeSlowRelayLeaves(
              spokePoolClients,
              balanceAllocator,
              config.sendingExecutionsEnabled,
              fromBlocks,
              [1]
            );
            await dataworker.executeRelayerRefundLeaves(
              spokePoolClients,
              balanceAllocator,
              config.sendingExecutionsEnabled,
              fromBlocks,
              [1]
            );
          }

          // Clear balances so when pool rebalance leaf executor runs again, it captures new incoming balances from
          // the mainnet spoke leaves.
          balanceAllocator.clearBalances();

          // Question: do we also have to .clearUsed() on the balanceAllocator?

          // Try to execute pool rebalance leaves with new balances. The leaves should be the same so we don't
          // need to reconstruct them.
          await dataworker.executePoolRebalanceLeaves(
            executablePoolRebalanceRoot.unexecutedLeaves.filter((leaf) => leaf.chainId !== 1),
            executablePoolRebalanceRoot.expectedTrees,
            spokePoolClients,
            balanceAllocator,
            config.sendingExecutionsEnabled
          );

          // No need to execute other spoke root leaves yet on this run as the roots are not relayed atomically
          // on any chain other than Mainnet, where the HubPool is located.
        } else {
          // Execute slow relays before relayer refunds to give them priority for any L2 funds.
          await dataworker.executeSlowRelayLeaves(
            spokePoolClients,
            balanceAllocator,
            config.sendingExecutionsEnabled,
            fromBlocks
          );
          await dataworker.executeRelayerRefundLeaves(
            spokePoolClients,
            balanceAllocator,
            config.sendingExecutionsEnabled,
            fromBlocks
          );
        }
      } else logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Executor disabled" });

      await clients.multiCallerClient.executeTransactionQueue();

      logger.debug({ at: "Dataworker#index", message: `Time to loop: ${(Date.now() - loopStart) / 1000}s` });

      if (await processEndPollingLoop(logger, "Dataworker", config.pollingDelay)) break;
    }
  } catch (error) {
    await disconnectRedisClient(logger);
    throw error;
  }
}

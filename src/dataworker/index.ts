import { TokenClient } from "../clients";
import {
  EvmAddress,
  SvmAddress,
  winston,
  config,
  getDeployedContract,
  getProvider,
  startupLogLevel,
  Signer,
  disconnectRedisClients,
  isDefined,
  getSvmSignerFromEvmSigner,
  waitForPubSub,
  averageBlockTime,
  getRedisPubSub,
} from "../utils";
import { spokePoolClientsToProviders } from "../common";
import { Dataworker } from "./Dataworker";
import { DataworkerConfig } from "./DataworkerConfig";
import {
  constructDataworkerClients,
  constructSpokePoolClientsForFastDataworker,
  getSpokePoolClientEventSearchConfigsForFastDataworker,
  DataworkerClients,
} from "./DataworkerClientHelper";
import { BalanceAllocator } from "../clients/BalanceAllocator";
import { PendingRootBundle, BundleData } from "../interfaces";

config();
let logger: winston.Logger;

const { RUN_IDENTIFIER: runIdentifier, BOT_IDENTIFIER: botIdentifier = "across-dataworker" } = process.env;

export async function createDataworker(
  _logger: winston.Logger,
  baseSigner: Signer,
  config?: DataworkerConfig
): Promise<{
  config: DataworkerConfig;
  clients: DataworkerClients;
  dataworker: Dataworker;
}> {
  config ??= new DataworkerConfig(process.env);
  const clients = await constructDataworkerClients(_logger, config, baseSigner);

  const dataworker = new Dataworker(
    _logger,
    config,
    clients,
    clients.configStoreClient.getChainIdIndicesForBlock(),
    config.maxRelayerRepaymentLeafSizeOverride,
    config.maxPoolRebalanceLeafSizeOverride,
    config.spokeRootsLookbackCount,
    config.bufferToPropose,
    config.forcePropose,
    config.forceProposalBundleRange
  );

  return {
    config,
    clients,
    dataworker,
  };
}

function resolvePersonality(config: DataworkerConfig): string {
  if (config.proposerEnabled) {
    return config.l1ExecutorEnabled ? "Proposer/Executor" : "Proposer";
  }

  if (config.l1ExecutorEnabled || config.l2ExecutorEnabled) {
    return "Executor";
  }

  if (config.disputerEnabled) {
    return "Disputer";
  }

  return "Dataworker"; // unknown
}

async function getChallengeRemaining(
  chainId: number,
  challengeBuffer: number,
  logger: winston.Logger
): Promise<number> {
  const provider = await getProvider(chainId);
  const latestBlock = await provider.getBlockNumber();
  const hubPool = getDeployedContract("HubPool", chainId).connect(provider);

  const [proposal, currentTime] = await Promise.all([
    hubPool.rootBundleProposal({
      blockTag: latestBlock,
    }),
    hubPool.getCurrentTime({
      blockTag: latestBlock,
    }),
  ]);
  const { challengePeriodEndTimestamp } = proposal;
  const challengeRemaining = Math.max(challengePeriodEndTimestamp + challengeBuffer - currentTime, 0);
  logger.debug({
    at: "Dataworker#index::getChallengeRemaining",
    message: "Challenge remaining",
    challengeRemaining,
    challengeBuffer,
    challengePeriodEndTimestamp,
    currentTime,
    blockTag: latestBlock,
  });

  return challengeRemaining;
}

async function canProposeRootBundle(chainId: number): Promise<boolean> {
  const provider = await getProvider(chainId);
  const hubPool = getDeployedContract("HubPool", chainId).connect(provider);

  const proposal = await hubPool.rootBundleProposal();
  const { unclaimedPoolRebalanceLeafCount } = proposal;
  return unclaimedPoolRebalanceLeafCount === 0;
}

export async function runDataworker(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  logger = _logger;

  const config = new DataworkerConfig(process.env);
  const personality = resolvePersonality(config);
  const challengeRemaining = await getChallengeRemaining(config.hubPoolChainId, 0, logger);

  // @dev The check for `runIdentifier` doubles as a check whether this instance is being run in GCP (or mocked as a production instance) and as a unique identifier
  // which can be cached in redis (that is, for any executor/proposer instance, the run identifier lets any other instance know of its existence via a redis mapping
  // from botIdentifier -> runIdentifier).
  if (
    isDefined(runIdentifier) &&
    challengeRemaining > config.minChallengeLeadTime &&
    (config.proposerEnabled || config.l1ExecutorEnabled)
  ) {
    logger[startupLogLevel(config)]({
      at: "Dataworker#index",
      message: `${personality} aborting (not ready)`,
      challengeRemaining,
    });
    return;
  }

  const { clients, dataworker } = await createDataworker(logger, baseSigner, config);
  await config.update(logger); // Update address filter.
  const l1BlockTime = (await averageBlockTime(clients.hubPoolClient.hubPool.provider)).average;
  const adjustedL1BlockTime = l1BlockTime + Number(process.env["L1_BLOCK_TIME_BUFFER"] ?? l1BlockTime); // Default adjustment is double l1BlockTime.
  let proposedBundleData: BundleData | undefined = undefined;
  let poolRebalanceLeafExecutionCount = 0;

  const pubSub = await getRedisPubSub(logger);
  try {
    // Explicitly don't log addressFilter because it can be huge and can overwhelm log transports.
    const { addressFilter: _addressFilter, ...loggedConfig } = config;
    logger[startupLogLevel(config)]({ at: "Dataworker#index", message: `${personality} started 👩‍🔬`, loggedConfig });

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
    if (config.disputerEnabled) {
      await dataworker.validatePendingRootBundle(spokePoolClients, fromBlocks);
    } else {
      logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Disputer disabled" });
    }

    if (config.proposerEnabled) {
      if (config.sendingTransactionsEnabled) {
        const tokenClient = new TokenClient(
          logger,
          EvmAddress.from(await baseSigner.getAddress()),
          SvmAddress.from(getSvmSignerFromEvmSigner(baseSigner).publicKey.toBase58()),
          {}, // SpokePoolClients not required
          clients.hubPoolClient
        );
        logger[startupLogLevel(config)]({
          at: "Dataworker#index",
          message: "Dataworker addresses",
          evmAddress: tokenClient.relayerEvmAddress.toNative(),
          svmAddress: tokenClient.relayerSvmAddress.toNative(),
        });
        await tokenClient.update();
        // Run approval on hub pool.
        await tokenClient.setBondTokenAllowance();
      }

      // Bundle data is defined if and only if there is a new bundle proposal transaction enqueued.
      proposedBundleData = await dataworker.proposeRootBundle(spokePoolClients, fromBlocks);
    } else {
      logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Proposer disabled" });
    }

    if (config.l2ExecutorEnabled || config.l1ExecutorEnabled) {
      const balanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(spokePoolClients));

      if (config.l1ExecutorEnabled) {
        poolRebalanceLeafExecutionCount = await dataworker.executePoolRebalanceLeaves(
          spokePoolClients,
          balanceAllocator,
          fromBlocks
        );
      }

      if (config.l2ExecutorEnabled) {
        // Execute slow relays before relayer refunds to give them priority for any L2 funds.
        await dataworker.executeSlowRelayLeaves(spokePoolClients, balanceAllocator, fromBlocks);
        await dataworker.executeRelayerRefundLeaves(spokePoolClients, balanceAllocator, fromBlocks);
      }
    } else {
      logger[startupLogLevel(config)]({ at: "Dataworker#index", message: "Executor disabled" });
    }

    // @dev The dataworker loop takes a long-time to run, so if the proposer is enabled, run a final check and early
    // exit if a proposal is already pending. Similarly, the executor is enabled and if there are pool rebalance
    // leaves to be executed but the proposed bundle was already executed, then exit early.
    const pendingProposal: PendingRootBundle = await clients.hubPoolClient.hubPool.rootBundleProposal();

    const proposalCollision =
      isDefined(proposedBundleData) &&
      pendingProposal.unclaimedPoolRebalanceLeafCount > 0 &&
      !config.awaitChallengePeriod;
    // The pending root bundle that we want to execute has already been executed if its unclaimed leaf count
    // does not match the number of leaves the executor wants to execute, or the pending root bundle's
    // challenge period timestamp is in the future. This latter case is rarer but it can
    // happen if a proposal in addition to the root bundle execution happens in the middle of this executor run.
    const executorCollision =
      poolRebalanceLeafExecutionCount > 0 &&
      (pendingProposal.unclaimedPoolRebalanceLeafCount !== poolRebalanceLeafExecutionCount ||
        (pendingProposal.challengePeriodEndTimestamp > clients.hubPoolClient.currentTime &&
          !config.awaitChallengePeriod));
    if (proposalCollision || executorCollision) {
      logger[startupLogLevel(config)]({
        at: "Dataworker#index",
        message: "Exiting early due to dataworker function collision",
        proposalCollision,
        proposedBundleDataDefined: isDefined(proposedBundleData),
        executorCollision,
        poolRebalanceLeafExecutionCount,
        unclaimedPoolRebalanceLeafCount: pendingProposal.unclaimedPoolRebalanceLeafCount,
        challengePeriodNotPassed: pendingProposal.challengePeriodEndTimestamp > clients.hubPoolClient.currentTime,
        pendingProposal,
      });
    } else {
      // If the proposer/executor is expected to await its challenge period:
      // - We need a defined redis instance so we can publish our botIdentifier and runIdentifier (so future instances are aware of our existence).
      // - We need to check whether we have an enqueued transaction in the multiCallerClient. Having no transaction there indicates that the executor/proposer instance
      //   exited early for a valid reason (such as insufficient lookback), so there would be no reason to await submitting a transaction.
      const hasTransactionQueued = clients.multiCallerClient.transactionCount() !== 0;
      if ((config.l1ExecutorEnabled || config.proposerEnabled) && pubSub && runIdentifier && hasTransactionQueued) {
        const challengeBuffer = Number(process.env.L1_EXECUTOR_CHALLENGE_BUFFER ?? 24); // Default to 24 seconds or 2 blocks.
        let updatedChallengeRemaining = await getChallengeRemaining(config.hubPoolChainId, challengeBuffer, logger);
        // If the updated challenge remaining is greater than the challenge remaining we observed at the start, then this indicates that during the runtime of this bot,
        // an executor instance executed the pending root bundle out of the hub _and_ a proposer instance proposed a new root bundle.
        if (updatedChallengeRemaining > challengeRemaining) {
          logger.debug({
            at: "Dataworker#index",
            message: `Exiting due to ${personality} collision.`,
            challengeRemaining,
            updatedChallengeRemaining,
          });
          return;
        }
        let counter = 0;

        // publish so that other instances can see that we're running
        await pubSub.pub(botIdentifier, runIdentifier);
        logger.debug({
          at: "Dataworker#index",
          message: `Published signal to ${botIdentifier} instances.`,
        });

        while (updatedChallengeRemaining > 0 && ++counter < 5) {
          logger.debug({
            at: "Dataworker#index",
            message: `Waiting for updated challenge remaining ${updatedChallengeRemaining}`,
          });
          const handover = await waitForPubSub(
            pubSub,
            botIdentifier,
            runIdentifier,
            (updatedChallengeRemaining + adjustedL1BlockTime) * 1000
          );
          if (handover) {
            logger.debug({
              at: "Dataworker#index",
              message: `Handover signal received from ${botIdentifier} instance ${runIdentifier}.`,
            });
            return;
          } else {
            logger.debug({
              at: "Dataworker#index",
              message: `No handover signal received from ${botIdentifier} instance ${runIdentifier}. Continuing...`,
              retries: counter,
            });
          }

          updatedChallengeRemaining = await getChallengeRemaining(config.hubPoolChainId, challengeBuffer, logger);
        }
        if (config.proposerEnabled) {
          // Clear the counter
          counter = 0;
          let canPropose = await canProposeRootBundle(config.hubPoolChainId);
          while (!canPropose && ++counter < 10) {
            logger.debug({
              at: "Dataworker#index",
              message: "Waiting for the l1 executor to execute pool rebalance roots.",
            });
            const handover = await waitForPubSub(pubSub, botIdentifier, runIdentifier, l1BlockTime * 1000);
            if (handover) {
              logger.debug({
                at: "Dataworker#index",
                message: `Handover signal received from ${botIdentifier} instance ${runIdentifier}.`,
              });
              return;
            } else {
              logger.debug({
                at: "Dataworker#index",
                message: `No handover signal received from ${botIdentifier} instance ${runIdentifier}. Continuing...`,
                retries: counter,
              });
            }
            canPropose = await canProposeRootBundle(config.hubPoolChainId);
          }
          // The proposer waited ~10 blocks for the executor's transaction to succeed before exiting.
          if (!canPropose) {
            return;
          }
        }
      }

      await clients.multiCallerClient.executeTxnQueues();
    }
  } finally {
    await disconnectRedisClients(logger);
  }
}

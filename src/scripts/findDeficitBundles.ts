import {
  winston,
  config,
  BigNumber,
  Logger,
  delay,
  getFillsInRange,
  getNetworkName,
  toBN,
  Contract,
  ERC20,
  etherscanLink,
  sortEventsAscending,
} from "../utils";
import { updateDataworkerClients } from "../dataworker/DataworkerClientHelper";
import { createDataworker } from "../dataworker";
import { constructSpokePoolClientsForBlockAndUpdate, updateSpokePoolClients } from "../common";

config();
let logger: winston.Logger;

export async function findDeficitBundles(_logger: winston.Logger) {
  logger = _logger;

  const { clients, dataworker } = await createDataworker(logger);
  await updateDataworkerClients(clients);

  const hubPoolClient = clients.hubPoolClient;
  const spokePoolClients = await constructSpokePoolClientsForBlockAndUpdate(
    dataworker.chainIdListForBundleEvaluationBlockNumbers,
    clients,
    logger,
    hubPoolClient.latestBlockNumber,
    [
      "FundsDeposited",
      "RequestedSpeedUpDeposit",
      "FilledRelay",
      "EnabledDepositRoute",
      "RelayedRootBundle",
      "ExecutedRelayerRefundRoot",
    ]
  );
  await updateSpokePoolClients(spokePoolClients);

  // TODO: Consider moving this to .env
  // This can be updated to restrict the search. Only bundles proposed after this block number of mainnet are examined.
  const startBlockNumber = 0;

  const latestMainnetBlock = hubPoolClient.latestBlockNumber;
  const bundleStartBlocks = Object.fromEntries(
    dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId) => [chainId, 0])
  );
  const bundleRanges: BigNumber[] = Array(dataworker.chainIdListForBundleEvaluationBlockNumbers.length).fill(toBN(0));

  const allBundles = sortEventsAscending(hubPoolClient.getProposedRootBundles());
  for (const bundle of allBundles) {
    // Skip all bundles older than search's start or bundle that were not executed.
    if (bundle.blockNumber < startBlockNumber || !hubPoolClient.isRootBundleValid(bundle, latestMainnetBlock)) {
      continue;
    }

    // Calculate bundle ids for this bundle on all chains.
    let duplicateBundlesFound = false;
    for (const chainId of dataworker.chainIdListForBundleEvaluationBlockNumbers) {
      const bundleIds = spokePoolClients[chainId]
        .getRootBundleRelays()
        .filter((b) => b.relayerRefundRoot === bundle.relayerRefundRoot)
        .map((bundle) => bundle.rootBundleId);
      if (bundleIds.length > 1) {
        logger.warn({
          at: "findDeficitBundles",
          message: "Multiple bundles found",
          network: getNetworkName(chainId),
          bundleIds,
          mainnetBundle: bundle,
        });

        duplicateBundlesFound = true;
      }
    }

    if (duplicateBundlesFound) {
      const bundleBlockRanges = dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId, index) => {
        return [bundleStartBlocks[chainId], bundle.bundleEvaluationBlockNumbers[index].toNumber()];
      });
      const { fillsToRefund, deposits, allValidFills, unfilledDeposits } = clients.bundleDataClient.loadData(
        bundleBlockRanges,
        spokePoolClients
      );
      const allValidFillsInRange = getFillsInRange(
        allValidFills,
        bundleBlockRanges,
        dataworker.chainIdListForBundleEvaluationBlockNumbers
      );
      const poolRebalanceRoot = dataworker._getPoolRebalanceRoot(
        bundleBlockRanges,
        hubPoolClient.latestBlockNumber,
        fillsToRefund,
        deposits,
        allValidFills,
        allValidFillsInRange,
        unfilledDeposits,
        true
      );
      const { leaves: allRefundLeaves } = dataworker.buildRelayerRefundRoot(
        bundleBlockRanges,
        fillsToRefund,
        poolRebalanceRoot.leaves,
        poolRebalanceRoot.runningBalances
      );
      logger.info({
        at: "findDeficitBundles",
        message: "Reconstructed bundle",
        refundLeaves: poolRebalanceRoot.leaves,
        rebalanceLeaves: allRefundLeaves,
      });
    }

    /*
    dataworker.chainIdListForBundleEvaluationBlockNumbers.forEach((chainId, index) => {
      const currentBundleEndBlock = bundle.bundleEvaluationBlockNumbers[index];
      logger.info({
        at: "findDeficitBundles",
        message: `Examining bundle ${bundleIds[chainId]} on ${getNetworkName(chainId)} with end block ${currentBundleEndBlock}. Previous end block: ${bundleRanges[index]}`,
        bundle,
        currentEndingBlock: currentBundleEndBlock.toString(),
        previousEndingBlock: bundleRanges[index].toString(),
      });

      if (currentBundleEndBlock.lt(bundleRanges[index])) {
        logger.warn({
          at: "findDeficitBundles",
          message: `Overlapping bundle ranges found at bundle ${bundleIds[chainId]} for ${getNetworkName(chainId)} with ending block ${currentBundleEndBlock}`,
          bundle,
          currentEndingBlock: currentBundleEndBlock.toString(),
          previousEndingBlock: bundleRanges[index].toString(),
        });
      }
      bundleRanges[index] = currentBundleEndBlock;
    });
     */

    /*
    // Calculate the balances required for each token on each chain to satisfy refunds and returns (to HubPool).
    const requiredFundsPerChain: { [chainId: number]: { [token: string]: BigNumber } } = {};
    for (const leaf of allRefundLeaves) {
      if (requiredFundsPerChain[leaf.chainId] === undefined) {
        requiredFundsPerChain[leaf.chainId] = {};
      }
      if (requiredFundsPerChain[leaf.chainId][leaf.l2TokenAddress] === undefined) {
        requiredFundsPerChain[leaf.chainId][leaf.l2TokenAddress] = toBN(0);
      }

      const totalRefundAmount = leaf.refundAmounts.length > 0 ? leaf.refundAmounts.reduce((a, b) => a.add(b)) : toBN(0);
      requiredFundsPerChain[leaf.chainId][leaf.l2TokenAddress] = requiredFundsPerChain[leaf.chainId][
        leaf.l2TokenAddress
      ]
        .add(leaf.amountToReturn)
        .add(totalRefundAmount);
    }

    // Deduct net send amounts and running balances from rebalance leaves. These are the funds HubPool is sending to
    // SpokePools to help cover refunds.
    for (const leaf of poolRebalanceRoot.leaves) {
      for (let i = 0; i < leaf.l1Tokens.length; i++) {
        // Net send amount is negative when funds will be sent back from SpokePool to HubPool.
        // We'll skip these as they are accounted for already by amountToReturn, which is a net outflow
        // from SpokePools
        if (leaf.netSendAmounts[i].lt(toBN(0))) continue;

        const l1Token = leaf.l1Tokens[i];
        const l2Token = hubPoolClient.getDestinationTokenForL1Token(l1Token, leaf.chainId);

        if (requiredFundsPerChain[leaf.chainId] === undefined ||
          requiredFundsPerChain[leaf.chainId][l2Token] === undefined) {
          continue;
        }
        requiredFundsPerChain[leaf.chainId][l2Token] = requiredFundsPerChain[leaf.chainId][l2Token].sub(
          leaf.netSendAmounts[i]
        ).sub(leaf.runningBalances[i]);
      }
    }

    const refundLeavesByChain: { [chainId: number]: { [token: string]: any[] } } = {};
    for (const leaf of allRefundLeaves) {
      if (refundLeavesByChain[leaf.chainId] === undefined) {
        refundLeavesByChain[leaf.chainId] = {};
      }
      if (refundLeavesByChain[leaf.chainId][leaf.l2TokenAddress] === undefined) {
        refundLeavesByChain[leaf.chainId][leaf.l2TokenAddress] = [];
      }
      refundLeavesByChain[leaf.chainId][leaf.l2TokenAddress].push(leaf);
    }
    const rebalanceLeavesByChain: { [chainId: number]: any[] } = {};
    for (const leaf of poolRebalanceRoot.leaves) {
      if (rebalanceLeavesByChain[leaf.chainId] === undefined) {
        rebalanceLeavesByChain[leaf.chainId] = [];
      }
      rebalanceLeavesByChain[leaf.chainId].push(leaf);
    }

    // Check if balances on any chain at the time the bundle is proposed or executed are insufficient to execute all
    // refund leaves.
    for (const chainIdStr of Object.keys(requiredFundsPerChain)) {
      const chainId = Number(chainIdStr);
      const spokePoolClient = spokePoolClients[chainId];
      const spokePoolAddress = spokePoolClient.spokePool.address;
      const executedRebalanceLeaves = hubPoolClient.getExecutedLeavesForRootBundle(bundle, latestMainnetBlock);
      const rebalanceExecutionBlockNumber = executedRebalanceLeaves[0].blockNumber;

      for (const token of Object.keys(requiredFundsPerChain[chainId])) {
        const requiredFunds = requiredFundsPerChain[chainId][token];
        const tokenContract = new Contract(token, ERC20.abi, spokePoolClient.spokePool.provider);
        const networkName = getNetworkName(chainId);
        const bundleProposalTx = etherscanLink(bundle.transactionHash, 1);
        const bundleId = bundleIds[chainId];

        const balanceAtProposal = await tokenContract.balanceOf(spokePoolAddress, { blockTag: bundle.blockNumber });
        if (balanceAtProposal.lt(requiredFunds)) {
          logger.warn({
            at: "findDeficitBundles",
            message: `Balance of token ${token} on chain ${networkName} at proposal time ${bundle.blockNumber} for bundle ${bundleId} is insufficient to execute leaves`,
            bundle: bundleProposalTx,
            requiredFunds: requiredFunds.toString(),
            balanceAtProposal: balanceAtProposal.toString(),
            refundLeaves: refundLeavesByChain[chainId][token],
            rebalanceLeaves: rebalanceLeavesByChain[chainId],
          });
        }

        const balanceAtRebalanceExecution = await tokenContract.balanceOf(spokePoolAddress, {
          blockTag: rebalanceExecutionBlockNumber,
        });
        if (balanceAtRebalanceExecution.lt(requiredFunds)) {
          logger.warn({
            at: "findDeficitBundles",
            message: `Balance of token ${token} on chain ${networkName} at execution time ${rebalanceExecutionBlockNumber} for bundle ${bundleId} is insufficient to execute leaves`,
            bundle: bundleProposalTx,
            requiredFunds: requiredFunds.toString(),
            balanceAtRebalanceExecution: balanceAtRebalanceExecution.toString(),
            refundLeaves: refundLeavesByChain[chainId][token],
            rebalanceLeaves: rebalanceLeavesByChain[chainId],
          });
        }
      }
    }
     */
  }
}

export async function run(_logger: winston.Logger) {
  // Keep trying to validate until it works.
  try {
    await findDeficitBundles(_logger);
  } catch (error) {
    console.error(error);
    logger.error({ at: "findDeficitBundles", message: "Caught an error, retrying!", error });
    await delay(5);
    await run(Logger);
  }
}

if (require.main === module) {
  run(Logger)
    .then(() => {
      // eslint-disable-next-line no-process-exit
      process.exit(0);
    })
    .catch(async (error) => {
      logger.error({ at: "InfrastructureEntryPoint", message: "There was an error in the main entry point!", error });
      await delay(5);
      await run(Logger);
    });
}

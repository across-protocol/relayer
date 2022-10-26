import { winston, config, Logger, delay, toBN, sortEventsAscending, getSigner, toBNWei } from "../utils";
import {
  constructSpokePoolClientsForFastDataworker,
  getSpokePoolClientEventSearchConfigsForFastDataworker,
  updateDataworkerClients,
} from "../dataworker/DataworkerClientHelper";
import { createDataworker } from "../dataworker";
import { updateSpokePoolClients } from "../common";
import { DepositWithBlock } from "../interfaces";
import { BigNumber } from "ethers";
import _ from "lodash";

config();
let logger: winston.Logger;

export async function findDeficitBundles(_logger: winston.Logger) {
  logger = _logger;

  const baseSigner = await getSigner();
  const { clients, config, dataworker } = await createDataworker(logger, baseSigner);
  await updateDataworkerClients(clients);

  const hubPoolClient = clients.hubPoolClient;
  const { fromBlocks, toBlocks } = getSpokePoolClientEventSearchConfigsForFastDataworker(config, clients, dataworker);
  const spokePoolClients = await constructSpokePoolClientsForFastDataworker(
    logger,
    clients.configStoreClient,
    config,
    baseSigner,
    fromBlocks,
    toBlocks
  );
  await updateSpokePoolClients(spokePoolClients);

  // WBTC.
  const tokenOfInterest = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";

  const latestMainnetBlock = hubPoolClient.latestBlockNumber;
  const bundleStartBlocks: { [chainId: number]: number } = Object.fromEntries(
    dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId) => [chainId, 0])
  );

  const allBundles = sortEventsAscending(hubPoolClient.getProposedRootBundles());
  // The fast bundle lookback only applies to SpokePoolClient's events. HubPoolClient still loads all events.
  // We need to track how many bundles have been processed from HubPoolClient, so we don't process those that are not
  // covered by the SpokePoolClient's lookback.
  let bundleCount = 0;
  const previousBundleData = {};
  for (const bundle of allBundles) {
    // Skip bundles that were not executed.
    if (!hubPoolClient.isRootBundleValid(bundle, latestMainnetBlock)) {
      continue;
    }

    // Stop once we have processed enough bundles from HubPoolClient.
    if (++bundleCount > config.dataworkerFastLookbackCount) break;

    // Track the deposits going to a specific chain during the bundle's block range.
    // We'll need this later to validate fills on the destination chains.
    const depositsByOriginChain: { [chainId: number]: DepositWithBlock[] } = Object.fromEntries(
      dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId) => [chainId, []])
    );
    const arrivingDepositsByChain: { [chainId: number]: DepositWithBlock[] } = Object.fromEntries(
      dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId) => [chainId, []])
    );
    for (const [chainIdx, originChainId] of dataworker.chainIdListForBundleEvaluationBlockNumbers.entries()) {
      // Edge case: Some bundles don't include all chains (e.g. when there was no activity or in admin bundles).
      if (!bundle.bundleEvaluationBlockNumbers[chainIdx]) {
        continue;
      }

      const spokePoolClient = spokePoolClients[originChainId];
      const startingBlock = bundleStartBlocks[originChainId];
      const endingBlock = bundle.bundleEvaluationBlockNumbers[chainIdx].toNumber();
      const originToken = hubPoolClient.getDestinationTokenForL1Token(tokenOfInterest, originChainId);
      // Filter for deposits within the bundle's block range and for the token of interest.
      const deposits = spokePoolClient
        .getDeposits()
        .filter(
          (deposit: DepositWithBlock) =>
            deposit.originBlockNumber <= endingBlock &&
            deposit.originBlockNumber >= startingBlock &&
            deposit.originToken === originToken
        ) as DepositWithBlock[];

      // Add copies of the deposits to both the origin and destination chains' lists.
      for (const deposit of deposits) {
        const destinationChainId = deposit.destinationChainId;
        depositsByOriginChain[originChainId].push(_.cloneDeep(deposit));
        arrivingDepositsByChain[destinationChainId].push(_.cloneDeep(deposit));
      }
    }

    // For each chain for the current bundle, examine:
    // 1. Valid fills on that chain. The refunds for these fills needed to be added to refund chain's running balance.
    // 2. All deposits originating from that chain. These needed to be subtracted from running balance.
    // 3. Deposits arriving at that chain with unfilled amount > 0. These are slow fills and need to be added to the
    // running balance.
    const runningBalances: { [chainId: number]: BigNumber } = {};
    for (const chainId of dataworker.chainIdListForBundleEvaluationBlockNumbers) {
      runningBalances[chainId] = toBN(0);
    }

    const validFillsByDestinationChain = {};
    const unfilledDepositByDestinationChain = {};
    const invalidFillsByDestinationChain = {};
    for (const [chainIdx, chainId] of dataworker.chainIdListForBundleEvaluationBlockNumbers.entries()) {
      // Edge case: Some bundles don't include all chains (e.g. when there was no activity or in admin bundles).
      if (!bundle.bundleEvaluationBlockNumbers[chainIdx]) {
        continue;
      }

      const spokePoolClient = spokePoolClients[chainId];
      const startingBlock = bundleStartBlocks[chainId];
      const endingBlock = bundle.bundleEvaluationBlockNumbers[chainIdx].toNumber();
      const localTokenOfInterest = hubPoolClient.getDestinationTokenForL1Token(tokenOfInterest, chainId);
      const arrivingDeposits = arrivingDepositsByChain[chainId];
      const fills = spokePoolClient
        .getFillsWithBlockInRange(startingBlock, endingBlock)
        .filter((fill) => fill.destinationToken === localTokenOfInterest);

      const validFills = fills.filter((fill) => {
        const matchingDeposit = arrivingDeposits.find((deposit) => deposit.depositId == fill.depositId);
        const isValid = matchingDeposit && spokePoolClient.validateFillForDeposit(fill, matchingDeposit);
        // Track invalid fills for debugging purposes.
        if (!isValid) {
          if (invalidFillsByDestinationChain[chainId] === undefined) invalidFillsByDestinationChain[chainId] = [];
          const invalidFill = _.cloneDeep(fill);
          invalidFill["deposit"] = matchingDeposit;
          invalidFillsByDestinationChain[chainId].push(invalidFill);
        }
        return isValid;
      });
      // Add any valid fill's amount to the refund chain's runningBalance.
      for (const validFill of validFills) {
        const refundAmount = validFill.fillAmount.mul(toBNWei(1).sub(validFill.realizedLpFeePct)).div(toBNWei(1));
        runningBalances[validFill.repaymentChainId] = runningBalances[validFill.repaymentChainId]
          ? runningBalances[validFill.repaymentChainId].add(refundAmount)
          : refundAmount;
      }

      const unfilledDeposits = [];
      for (const deposit of arrivingDeposits) {
        const matchingFills = fills.filter((fill) => fill.depositId == deposit.depositId);
        const depositClone = _.cloneDeep(deposit);
        depositClone.amount = deposit.amount.sub(matchingFills.reduce((acc, fill) => acc.add(fill.amount), toBN(0)));
        // Deposits with remaining unfilled amount > 0 would lead to a slow fill.
        if (depositClone.amount.gt(toBN(0))) {
          unfilledDeposits.push(depositClone);
        }
      }
      // Add any unfilled deposits' amount (slow fills) to the destination chain's running balance.
      for (const unfilledDeposit of unfilledDeposits) {
        const destinationChainId = unfilledDeposit.destinationChainId;
        runningBalances[destinationChainId] = runningBalances[destinationChainId].add(unfilledDeposit.amount);
        if (!unfilledDepositByDestinationChain[destinationChainId])
          unfilledDepositByDestinationChain[destinationChainId] = [];
        unfilledDepositByDestinationChain[destinationChainId].push(unfilledDeposit);
      }

      // Subtract all deposits on the current chain from its running balance.
      for (const originatingDeposit of depositsByOriginChain[chainId]) {
        runningBalances[chainId] = runningBalances[chainId].sub(originatingDeposit.amount);
      }

      // Update the starting block now that we've examined this (executed) bundle on this chain.
      validFillsByDestinationChain[chainId] = validFills;
      bundleStartBlocks[chainId] = endingBlock + 1;
    }

    // Compare computed running balances with executed leaves.
    const followingBlockNumber = clients.hubPoolClient.getFollowingRootBundle(bundle)?.blockNumber;
    const executedLeaves = clients.hubPoolClient.getExecutedLeavesForRootBundle(bundle, followingBlockNumber);
    for (const [chainIdx, chainId] of dataworker.chainIdListForBundleEvaluationBlockNumbers.entries()) {
      for (const leaf of executedLeaves) {
        // Match leaf by chain id. There's no other concrete ids to match by.
        if (!leaf.runningBalances[chainIdx]) continue;
        const leafChainId = leaf.chainId;
        if (leafChainId == chainId) {
          const tokenIdx = leaf.l1Tokens.indexOf(tokenOfInterest);
          if (tokenIdx < 0) continue;

          // Compare computed running balance with the leaf's actual running balance/net send amount.
          const leafRunningBalance = leaf.runningBalances[tokenIdx].toString();
          const leafNetSendAmount = leaf.netSendAmounts[tokenIdx].toString();
          const computedRunningBalance = runningBalances[chainId].toString();
          // Actual bundles constructed by the dataworker also include previous bundles' running balances if > 0.
          // We also want to simulate that here to avoid false mismatches.
          const computedRunningBalanceWithPrevious =
            previousBundleData[leafChainId] && previousBundleData[leafChainId].leafRunningBalance
              ? runningBalances[chainId].add(previousBundleData[leafChainId].leafRunningBalance).toString()
              : computedRunningBalance;
          if (
            computedRunningBalance !== leafRunningBalance &&
            computedRunningBalance !== leafNetSendAmount &&
            computedRunningBalanceWithPrevious != leafRunningBalance &&
            computedRunningBalanceWithPrevious != leafNetSendAmount
          ) {
            const deficitAmount = toBN(computedRunningBalanceWithPrevious)
              .sub(toBN(leafRunningBalance).add(toBN(leafNetSendAmount)))
              .toString();
            logger.error({
              message: `Mismatching running balances for chain ${chainId}`,
              bundleId: bundleCount,
              bundle: bundle.transactionHash,
              deficitAmount,
              leafRunningBalance,
              leafNetSendAmount,
              computedRunningBalance,
              computedRunningBalanceWithPrevious,
              leafExec: leaf.transactionHash,
              validFills: validFillsByDestinationChain[leafChainId],
              deposits: depositsByOriginChain[leafChainId],
              slowFills: unfilledDepositByDestinationChain[leafChainId],
              previousBundleData: previousBundleData[leafChainId],
              invalidFills: invalidFillsByDestinationChain[leafChainId],
            });
          }

          previousBundleData[leafChainId] = {
            leafRunningBalance,
            leafNetSendAmount,
          };
        }
      }
    }
  }
}

export async function run(_logger: winston.Logger) {
  // Keep trying to validate until it works.
  try {
    await findDeficitBundles(_logger);
  } catch (error) {
    console.error(error);
    logger.error({ at: "investigate", message: "Caught an error, retrying!", error });
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

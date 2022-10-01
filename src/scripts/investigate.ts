import {
  winston,
  config,
  Logger,
  delay,
  getFillsInRange,
  getNetworkName,
  toBN,
  Contract,
  ERC20,
  etherscanLink,
  sortEventsAscending,
  getSigner,
} from "../utils";
import { updateDataworkerClients } from "../dataworker/DataworkerClientHelper";
import { createDataworker } from "../dataworker";
import { constructSpokePoolClientsForBlockAndUpdate, updateSpokePoolClients } from "../common";
import { DepositWithBlock } from "../interfaces";
import { BigNumber } from "ethers";

config();
let logger: winston.Logger;

export async function findDeficitBundles(_logger: winston.Logger) {
  logger = _logger;

  const baseSigner = await getSigner();
  const { clients, dataworker } = await createDataworker(logger, baseSigner);
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

  // WBTC.
  const tokenOfInterest = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";

  const latestMainnetBlock = hubPoolClient.latestBlockNumber;
  const bundleStartBlocks: { [chainId: number]: number } = Object.fromEntries(
    dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId) => [chainId, 0])
  );

  const allBundles = sortEventsAscending(hubPoolClient.getProposedRootBundles());
  for (const bundle of allBundles) {
    // Skip bundles that were not executed.
    if (!hubPoolClient.isRootBundleValid(bundle, latestMainnetBlock)) {
      //console.log("Bundle not executed. Skipping...");
      continue;
    }

    // Populate the deposits going to a specific chain during the bundle's block range.
    const arrivingDepositsByChain: { [chainId: number]: DepositWithBlock[] } = {};
    for (const destinationChainId of dataworker.chainIdListForBundleEvaluationBlockNumbers) {
      //console.log("Populating deposits for destination", destinationChainId);
      for (const [chainIdx, originChainId] of dataworker.chainIdListForBundleEvaluationBlockNumbers.entries()) {
        if (!bundle.bundleEvaluationBlockNumbers[chainIdx]) {
          //console.log(`${originChainId} not in bundle`);
          continue;
        }
        //console.log(`Populating deposits from ${originChainId} to ${destinationChainId}`);

        const spokePoolClient = spokePoolClients[originChainId];
        const startingBlock = bundleStartBlocks[originChainId];
        const endingBlock = bundle.bundleEvaluationBlockNumbers[chainIdx].toNumber();
        const originToken = hubPoolClient.getDestinationTokenForL1Token(tokenOfInterest, originChainId);
        //console.log(`originToken on ${originChainId}: ${originToken}`);
        const deposits = spokePoolClient
          .getDepositsForDestinationChain(destinationChainId)
          .filter(
            (deposit: DepositWithBlock) =>
              deposit.originBlockNumber <= endingBlock &&
              deposit.originBlockNumber >= startingBlock &&
              deposit.originToken === originToken
          ) as DepositWithBlock[];
        /*
        logger.info({
          at: "findDeficitBundles",
          message: `FOUND ${deposits.length} deposits from ${originChainId} to ${destinationChainId}`,
          startingBlock,
          endingBlock,
          originToken,
          bundleBlockNumbers: bundle.bundleEvaluationBlockNumbers,
        });
         */

        if (arrivingDepositsByChain[destinationChainId] === undefined) arrivingDepositsByChain[destinationChainId] = [];
        arrivingDepositsByChain[destinationChainId] = arrivingDepositsByChain[destinationChainId].concat(deposits);
      }
    }

    // For each chain for the current bundle, examine:
    // 1. Valid fills on that chain. The refunds for these fills needed to be added to previous bundle's running balance
    // 2. All deposits originating from that chain. These needed to be subtracted from previous bundle's running balance
    // 3. Deposits arriving at that chain with unfilled amount > 0. These are slow fills and need to be added to the
    // previous bundle's running balance.
    //console.log("MOVING ON");
    const runningBalances: { [chainId: number]: BigNumber } = {};
    for (const chainId of dataworker.chainIdListForBundleEvaluationBlockNumbers) {
      runningBalances[chainId] = toBN(0);
    }

    for (const [chainIdx, destinationChainId] of dataworker.chainIdListForBundleEvaluationBlockNumbers.entries()) {
      if (!bundle.bundleEvaluationBlockNumbers[chainIdx]) {
        //console.log(`Bundle number not found ${chainIdx} ${destinationChainId} ${bundle.bundleEvaluationBlockNumbers}`);
        continue;
      }

      const spokePoolClient = spokePoolClients[destinationChainId];
      const startingBlock = bundleStartBlocks[destinationChainId];
      const endingBlock = bundle.bundleEvaluationBlockNumbers[chainIdx].toNumber();
      const localTokenOfInterest = hubPoolClient.getDestinationTokenForL1Token(tokenOfInterest, destinationChainId);
      //console.log(`localTokenOfInterest on ${destinationChainId}: ${localTokenOfInterest}`);
      const arrivingDeposits = arrivingDepositsByChain[destinationChainId];
      //console.log(`FOUND ${arrivingDeposits.length} arriving deposits`);

      const fills = spokePoolClient
        .getFillsWithBlockInRange(startingBlock, endingBlock)
        .filter((fill) => fill.destinationToken === localTokenOfInterest);
      //console.log(`FOUND ${fills.length} fills`);

      const validFills = fills.filter((fill) => {
        const matchingDeposit = arrivingDeposits.find((deposit) => deposit.depositId == fill.depositId);
        return matchingDeposit && spokePoolClient.validateFillForDeposit(fill, matchingDeposit);
      });
      //console.log(`FOUND ${validFills.length} valid fills`);
      // Add any valid fill's amount to the refunded chain's runningBalance.
      for (const validFill of validFills) {
        runningBalances[validFill.repaymentChainId] = runningBalances[validFill.repaymentChainId].add(
          validFill.fillAmount
        );
      }

      const unfilledDeposits = [];
      for (const deposit of arrivingDeposits) {
        const matchingFills = fills.filter((fill) => fill.depositId == deposit.depositId);
        deposit.amount = deposit.amount.sub(matchingFills.reduce((acc, deposit) => acc.add(deposit.amount), toBN(0)));
        if (deposit.amount.gt(toBN(0))) {
          unfilledDeposits.push(deposit);
        }
      }
      //console.log(`FOUND ${unfilledDeposits.length} unfilledDeposits`);
      // Add any unfilled deposits' amount (slow fills) to the destination chain's running balance.
      for (const unfilledDeposit of unfilledDeposits) {
        runningBalances[destinationChainId] = runningBalances[destinationChainId].add(unfilledDeposit.amount);
      }

      const originatingDeposits = spokePoolClient
        .getDeposits()
        .filter(
          (deposit) =>
            deposit.originBlockNumber <= endingBlock &&
            deposit.originBlockNumber >= startingBlock &&
            deposit.originToken === localTokenOfInterest
        );
      //console.log(`FOUND ${originatingDeposits.length} originatingDeposits`);
      // Subtract all deposits on the current chain from its running balance.
      for (const originatingDeposit of originatingDeposits) {
        runningBalances[originatingDeposit.originChainId] = runningBalances[originatingDeposit.originChainId].add(
          originatingDeposit.amount
        );
      }

      // Update the starting block now that we've examined this (executed) bundle on this chain.
      bundleStartBlocks[destinationChainId] = endingBlock + 1;
    }

    // Compare computed running balances with executed leaves.
    const followingBlockNumber = clients.hubPoolClient.getFollowingRootBundle(bundle)?.blockNumber;
    const executedLeaves = clients.hubPoolClient.getExecutedLeavesForRootBundle(bundle, followingBlockNumber);
    for (const [chainIdx, chainId] of dataworker.chainIdListForBundleEvaluationBlockNumbers.entries()) {
      //console.log(`Running balances for ${chainId}:`, runningBalances[chainId].toString());

      for (const leaf of executedLeaves) {
        if (!leaf.runningBalances[chainIdx]) continue;
        if (leaf.chainId == chainId) {
          const tokenIdx = leaf.l1Tokens.indexOf(tokenOfInterest);
          if (tokenIdx < 0) continue;
          const leafRunningBalance = leaf.runningBalances[tokenIdx];

          if (!runningBalances[chainId].eq(leafRunningBalance)) {
            console.log({
              message: `Mismatching running balances for chain ${chainId}`,
              bundle: bundle.transactionHash,
              computedRunningBalance: runningBalances[chainId].toString(),
              leafRunningBalance: leafRunningBalance.toString(),
              leafExec: leaf.transactionHash,
            });
          }
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

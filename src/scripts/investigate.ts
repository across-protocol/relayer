import {
  winston,
  config,
  Logger,
  delay,
  toBN,
  sortEventsAscending,
  getSigner, toBNWei,
} from "../utils";
import {
  constructSpokePoolClientsForFastDataworker,
  getSpokePoolClientEventSearchConfigsForFastDataworker,
  updateDataworkerClients
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
  const { fromBundle, toBundle, fromBlocks, toBlocks } = getSpokePoolClientEventSearchConfigsForFastDataworker(
    config,
    clients,
    dataworker
  );

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
  let count = 0;
  const previousBundleData = {};
  for (const bundle of allBundles) {
    // Skip bundles that were not executed.
    if (!hubPoolClient.isRootBundleValid(bundle, latestMainnetBlock)) {
      continue;
    }

    if (++count > config.dataworkerFastLookbackCount) break;
    // Populate the deposits going to a specific chain during the bundle's block range.
    const arrivingDepositsByChain: { [chainId: number]: DepositWithBlock[] } = {};
    for (const destinationChainId of dataworker.chainIdListForBundleEvaluationBlockNumbers) {
      for (const [chainIdx, originChainId] of dataworker.chainIdListForBundleEvaluationBlockNumbers.entries()) {
        if (!bundle.bundleEvaluationBlockNumbers[chainIdx]) {
          continue;
        }

        const spokePoolClient = spokePoolClients[originChainId];
        const startingBlock = bundleStartBlocks[originChainId];
        const endingBlock = bundle.bundleEvaluationBlockNumbers[chainIdx].toNumber();
        const originToken = hubPoolClient.getDestinationTokenForL1Token(tokenOfInterest, originChainId);
        const deposits = spokePoolClient
          .getDepositsForDestinationChain(destinationChainId)
          .filter(
            (deposit: DepositWithBlock) =>
              deposit.originBlockNumber <= endingBlock &&
              deposit.originBlockNumber >= startingBlock &&
              deposit.originToken === originToken
          ) as DepositWithBlock[];

        if (arrivingDepositsByChain[destinationChainId] === undefined) arrivingDepositsByChain[destinationChainId] = [];
        arrivingDepositsByChain[destinationChainId] = arrivingDepositsByChain[destinationChainId].concat(deposits);
      }
    }

    // For each chain for the current bundle, examine:
    // 1. Valid fills on that chain. The refunds for these fills needed to be added to previous bundle's running balance
    // 2. All deposits originating from that chain. These needed to be subtracted from previous bundle's running balance
    // 3. Deposits arriving at that chain with unfilled amount > 0. These are slow fills and need to be added to the
    // previous bundle's running balance.
    const runningBalances: { [chainId: number]: BigNumber } = {};
    for (const chainId of dataworker.chainIdListForBundleEvaluationBlockNumbers) {
      runningBalances[chainId] = toBN(0);
    }

    const validFillsByDestinationChain = {};
    const depositsByOriginChain = {};
    const unfilledDepositByDestinationChain = {};
    for (const [chainIdx, chainId] of dataworker.chainIdListForBundleEvaluationBlockNumbers.entries()) {
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
        return matchingDeposit && spokePoolClient.validateFillForDeposit(fill, matchingDeposit);
      });
      // Add any valid fill's amount to the refunded chain's runningBalance.
      for (const validFill of validFills) {
        const refundAmount = validFill.fillAmount.mul(toBNWei(1).sub(validFill.realizedLpFeePct)).div(toBNWei(1));
        runningBalances[validFill.repaymentChainId] = runningBalances[validFill.repaymentChainId].add(refundAmount);
      }

      const unfilledDeposits = [];
      for (const deposit of arrivingDeposits) {
        const matchingFills = fills.filter((fill) => fill.depositId == deposit.depositId);
        const depositClone = _.cloneDeep(deposit);
        depositClone.amount = deposit.amount.sub(matchingFills.reduce((acc, fill) => acc.add(fill.amount), toBN(0)));
        if (depositClone.amount.gt(toBN(0))) {
          unfilledDeposits.push(depositClone);
        }
      }
      // Add any unfilled deposits' amount (slow fills) to the destination chain's running balance.
      for (const unfilledDeposit of unfilledDeposits) {
        const destinationChainId = unfilledDeposit.destinationChainId;
        runningBalances[destinationChainId] = runningBalances[destinationChainId].add(unfilledDeposit.amount);
        if (!unfilledDepositByDestinationChain[destinationChainId]) unfilledDepositByDestinationChain[destinationChainId] = [];
        unfilledDepositByDestinationChain[destinationChainId].add(unfilledDeposit);
      }

      const originatingDeposits = spokePoolClient
        .getDeposits()
        .filter(
          (deposit) =>
            deposit.originBlockNumber <= endingBlock &&
            deposit.originBlockNumber >= startingBlock &&
            deposit.originToken === localTokenOfInterest
        );
      depositsByOriginChain[chainId] = originatingDeposits;
      // Subtract all deposits on the current chain from its running balance.
      for (const originatingDeposit of originatingDeposits) {
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
        if (!leaf.runningBalances[chainIdx]) continue;
        const leafChainId = leaf.chainId;
        if (leafChainId == chainId) {
          const tokenIdx = leaf.l1Tokens.indexOf(tokenOfInterest);
          if (tokenIdx < 0) continue;

          const leafRunningBalance = leaf.runningBalances[tokenIdx].toString();
          const leafNetSendAmount = leaf.netSendAmounts[tokenIdx].toString();
          previousBundleData[leafChainId] = {
            leafRunningBalance,
            leafNetSendAmount,
          };

          const computedRunningBalance = runningBalances[chainId].toString();

          if (computedRunningBalance !== leafRunningBalance && computedRunningBalance !== leafNetSendAmount) {
            console.log({
              message: `Mismatching running balances for chain ${chainId}`,
              bundle: bundle.transactionHash,
              leafRunningBalance,
              leafNetSendAmount,
              computedRunningBalance,
              leafExec: leaf.transactionHash,
              validFills: validFillsByDestinationChain[leafChainId],
              deposits: depositsByOriginChain[leafChainId],
              slowFills: unfilledDepositByDestinationChain[leafChainId],
              previousBundleData: previousBundleData[leafChainId],
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

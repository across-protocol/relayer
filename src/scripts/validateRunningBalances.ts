// This script can be run to check if there are currently any running balances (i.e. the running balances
// validated in the latest root bundle proposal) that defy invariants:
// - Invariant 1: For bundle i with bundle end block b, for each token t and chain c:
// - excess_t_c_i = token_balance_t_c_i
//                  + net_send_amount_t_c_i
//                  + running_balance_t_c_i
//                  - slow_fill_amount_t_c_i
//                  - relayer_refund_t_c_i
// - excess_t_c_i == excess_t_c_i+1, etc. for all i into the future.
// - where:
//    - token_balance_t_c_i is the token balance t of the spoke pool on chain c at block b
//    - net_send_amount_t_c_i is the net send amount of token t on chain c at block b, where negative values indicate
//      that tokens need to be returned from the spoke to the hub, and positive values vice versa
//    - running_balance_t_c_i is the running balance of token t on chain c at block b, where negative values indicate
//      that tokens need to be returned from the spoke to the hub, and positive values vice versa
//    - slow_fill_amount_t_c_i is the total amount of token t that needs to be slow filled on chain c at block b
//      indicating an amount of tokens that need to be taken out of the spoke pool to execute those slow fills
//    - relayer_refund_t_c_i is the total amount of token t that needs to be refunded to relayers on chain c at block b
//      which also indicates an amount of tokens that need to be taken out of the spoke pool to execute those refunds
//  - excess_t_c_{i,i+1,i+2,...} should therefore be consistent unless tokens are dropped onto the spoke pool.

import {
  Wallet,
  winston,
  config,
  getSigner,
  Logger,
  toBN,
  fromWei,
  Contract,
  ERC20,
  getProvider,
  EMPTY_MERKLE_ROOT,
  getDeployedContract,
  getDeploymentBlockNumber,
  sortEventsDescending,
  paginatedEventQuery,
  ZERO_ADDRESS,
} from "../utils";
import { updateDataworkerClients } from "../dataworker/DataworkerClientHelper";
import { createDataworker } from "../dataworker";
import { SpokePoolClient } from "../clients";

config();
let logger: winston.Logger;

export async function runScript(_logger: winston.Logger, baseSigner: Wallet): Promise<void> {
  logger = _logger;

  const { clients, dataworker, config } = await createDataworker(logger, baseSigner);
  await updateDataworkerClients(clients, false);

  const spokePools = Object.fromEntries(
    dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId) => {
      return [chainId, getDeployedContract("SpokePool", chainId, baseSigner).connect(getProvider(chainId))];
    })
  );
  const spokePoolDeploymentBlocks = dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId) => {
    return getDeploymentBlockNumber("SpokePool", chainId);
  });
  const spokePoolClients = Object.fromEntries(
    dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId, i) => {
      return [
        chainId,
        new SpokePoolClient(logger, spokePools[chainId], clients.configStoreClient, chainId, {
          fromBlock: spokePoolDeploymentBlocks[i],
          maxBlockLookBack: config.maxBlockLookBack[chainId],
        }),
      ];
    })
  );
  await Promise.all(
    Object.values(spokePoolClients).map((client) => client.update(["RelayedRootBundle", "ExecutedRelayerRefundRoot"]))
  );

  // Throw out most recent bundle as its leaves might not have executed.
  const validatedBundles = sortEventsDescending(clients.hubPoolClient.getValidatedRootBundles()).slice(1);
  const excesses: { [chainId: number]: { [l1Token: string]: string[] } } = {};
  const bundlesToValidate = 8; // Roughly 2 days worth of bundles.
  for (let x = 0; x < bundlesToValidate; x++) {
    const mostRecentValidatedBundle = validatedBundles[x];
    console.group(
      `Bundle #${x} proposed at block ${mostRecentValidatedBundle.blockNumber} (${mostRecentValidatedBundle.transactionHash})`
    );
    const followingBlockNumber =
      clients.hubPoolClient.getFollowingRootBundle(mostRecentValidatedBundle)?.blockNumber ||
      clients.hubPoolClient.latestBlockNumber;
    const poolRebalanceLeaves = clients.hubPoolClient.getExecutedLeavesForRootBundle(
      mostRecentValidatedBundle,
      followingBlockNumber
    );
    if (poolRebalanceLeaves.length !== mostRecentValidatedBundle.poolRebalanceLeafCount)
      throw new Error("PoolRebalanceLeaves not executed for bundle");

    if (mostRecentValidatedBundle.slowRelayRoot !== EMPTY_MERKLE_ROOT) {
      // TODO: Implement handling slow fills. I'm not sure if there is a way to do this without loading SpokePool
      // event data for this bundle's block range, which would slow this script down a lot so I'll exit early
      // and not handle this rare-ish case for now.
      throw new Error("Not implemented yet: root bundle contains slow fills");
    } else {
      for (const leaf of poolRebalanceLeaves) {
        for (let i = 0; i < leaf.l1Tokens.length; i++) {
          const l1Token = leaf.l1Tokens[i];
          const tokenInfo = clients.hubPoolClient.getTokenInfo(1, l1Token);
          if (!excesses[leaf.chainId]) {
            excesses[leaf.chainId] = {};
          }
          if (!excesses[leaf.chainId][tokenInfo.symbol]) {
            excesses[leaf.chainId][tokenInfo.symbol] = [];
          }

          console.group(`Leaf for chain ID ${leaf.chainId} and token ${tokenInfo.symbol} (${l1Token})`);
          const decimals = tokenInfo.decimals;
          const l2Token = clients.hubPoolClient.getDestinationTokenForL1Token(l1Token, leaf.chainId);
          const l2TokenContract = new Contract(l2Token, ERC20.abi, getProvider(leaf.chainId));
          const runningBalance = leaf.runningBalances[i];
          const netSendAmount = leaf.netSendAmounts[i];
          const bundleEndBlockForChain =
            mostRecentValidatedBundle.bundleEvaluationBlockNumbers[
              dataworker.chainIdListForBundleEvaluationBlockNumbers.indexOf(leaf.chainId)
            ];
          console.log(`- Bundle end block: ${bundleEndBlockForChain.toNumber()}`);
          let tokenBalanceAtBundleEndBlock = await l2TokenContract.balanceOf(spokePools[leaf.chainId].address, {
            blockTag: bundleEndBlockForChain.toNumber(),
          });

          // To paint a more accurate picture of the excess, we need to check that the previous bundle's leaf
          // has been executed by the time that we snapshot the spoke pool's token balance (at the bundle end block).
          // If it was executed after that time, then we need to subtract the amount from the token balance.
          const previousValidatedBundle = validatedBundles[x + 1];
          const previousRelayedRootBundle = spokePoolClients[leaf.chainId]
            .getRootBundleRelays()
            .find((_rootBundle) => _rootBundle.relayerRefundRoot === previousValidatedBundle.relayerRefundRoot);
          // If previous root bundle's doesn't have a refund leaf for this chain then skip this step
          if (previousRelayedRootBundle) {
            if (previousRelayedRootBundle.slowRelayRoot !== EMPTY_MERKLE_ROOT)
              throw new Error("Not implemented yet: previous root bundle contains slow fills");
            const previousLeafExecution = spokePoolClients[leaf.chainId]
              .getRelayerRefundExecutions()
              .find((e) => e.rootBundleId === previousRelayedRootBundle.rootBundleId && e.l2TokenAddress === l2Token);
            if (previousLeafExecution) {
              console.log(`- previous relayer refund leaf execution: ${previousLeafExecution.blockNumber}`);
              const previousLeafExecutedAfterBundleEndBlockForChain =
                previousLeafExecution.blockNumber > bundleEndBlockForChain.toNumber();
              console.log(
                `    - previous relayer refund leaf executed after bundle end block for chain: ${previousLeafExecutedAfterBundleEndBlockForChain}`
              );
              if (previousLeafExecutedAfterBundleEndBlockForChain) {
                const previousLeafRefundAmount = previousLeafExecution.refundAmounts.reduce(
                  (a, b) => a.add(b),
                  toBN(0)
                );
                console.log(
                  `    - subtracting previous leaf's amountToReturn (${fromWei(
                    previousLeafExecution.amountToReturn.toString(),
                    decimals
                  )}) and refunds (${fromWei(previousLeafRefundAmount.toString(), decimals)}) from token balance`
                );
                tokenBalanceAtBundleEndBlock = tokenBalanceAtBundleEndBlock
                  .sub(previousLeafExecution.amountToReturn)
                  .sub(previousLeafExecution.refundAmounts.reduce((a, b) => a.add(b), toBN(0)));
              }
            }

            // Make sure that previous root bundle's netSendAmount has been deposited into the spoke pool. We only
            // perform this check for chains 10, 137, 288, and 42161 because transfers from the hub pool to spoke
            // pools on those chains can take a variable amount of time, unlike transfers to the spoke pool on
            // mainnet. Additionally, deposits to those chains emit transfer events where the from address
            // is the zero address, making it easy to track.
            if ([10, 137, 288, 42161].includes(leaf.chainId)) {
              const _followingBlockNumber =
                clients.hubPoolClient.getFollowingRootBundle(previousValidatedBundle)?.blockNumber ||
                clients.hubPoolClient.latestBlockNumber;
              const previousBundlePoolRebalanceLeaves = clients.hubPoolClient.getExecutedLeavesForRootBundle(
                previousValidatedBundle,
                _followingBlockNumber
              );
              const previousBundleEndBlockForChain =
                previousValidatedBundle.bundleEvaluationBlockNumbers[
                  dataworker.chainIdListForBundleEvaluationBlockNumbers.indexOf(leaf.chainId)
                ];
              const previousPoolRebalanceLeaf = previousBundlePoolRebalanceLeaves.find(
                (_leaf) => _leaf.chainId === leaf.chainId && _leaf.l1Tokens.includes(l1Token)
              );
              if (previousPoolRebalanceLeaf) {
                const previousNetSendAmount =
                  previousPoolRebalanceLeaf.netSendAmounts[previousPoolRebalanceLeaf.l1Tokens.indexOf(l1Token)];
                console.log(`- previous net send amount: ${fromWei(previousNetSendAmount.toString(), decimals)}`);
                if (previousNetSendAmount.gt(toBN(0))) {
                  const depositsToSpokePool = (
                    await paginatedEventQuery(
                      l2TokenContract,
                      l2TokenContract.filters.Transfer(ZERO_ADDRESS, spokePools[leaf.chainId].address),
                      {
                        fromBlock: previousBundleEndBlockForChain.toNumber(),
                        toBlock: bundleEndBlockForChain.toNumber(),
                        maxBlockLookBack: config.maxBlockLookBack[leaf.chainId],
                      }
                    )
                  ).filter((e) => e.args.value.eq(previousNetSendAmount));
                  if (depositsToSpokePool.length === 0) {
                    console.log(
                      `    - adding previous leaf's netSendAmount (${fromWei(
                        previousNetSendAmount.toString(),
                        decimals
                      )}) to token balance because it did not arrive at spoke pool before bundle end block.`
                    );
                    tokenBalanceAtBundleEndBlock = tokenBalanceAtBundleEndBlock.add(previousNetSendAmount);
                  }
                }
              }
            }
          }

          const relayedRoot = spokePoolClients[leaf.chainId].getExecutedRefunds(
            mostRecentValidatedBundle.relayerRefundRoot
          );
          if (relayedRoot === undefined || relayedRoot[l2Token] === undefined) {
            console.log(`No relayed root for chain ID ${leaf.chainId} and token ${l2Token}`);
          } else {
            const executedRelayerRefund = Object.values(relayedRoot[l2Token]).reduce((a, b) => a.add(b), toBN(0));

            // Excess should theoretically be 0 but can be positive due to past accounting errors in computing running
            // balances. If excess is negative, then that means L2 leaves are unexecuted and the protocol could be
            // stuck.
            const excess = toBN(tokenBalanceAtBundleEndBlock)
              .add(netSendAmount)
              .sub(executedRelayerRefund)
              .add(runningBalance);
            excesses[leaf.chainId][tokenInfo.symbol].push(fromWei(excess.toString(), decimals));

            console.log(`- tokenBalance: ${fromWei(tokenBalanceAtBundleEndBlock.toString(), decimals)}`);
            console.log(`- netSendAmount: ${fromWei(netSendAmount.toString(), decimals)}`);
            console.log(`- executedRelayerRefund: ${fromWei(executedRelayerRefund.toString(), decimals)}`);
            console.log(
              `- (tokenBalance + netSendAmount - executedRefund): ${fromWei(
                tokenBalanceAtBundleEndBlock.add(netSendAmount).sub(executedRelayerRefund).toString(),
                decimals
              )}`
            );
            console.log(`- excess: ${fromWei(excess.toString(), decimals)}`);
            console.log(`- runningBalance: ${fromWei(runningBalance.toString(), decimals)}`);
          }
          console.groupEnd();
        }
      }
    }
    console.groupEnd();
  }
  // Print out historical excesses for chain ID and token to make it easy to see if excesses have changed.
  // They should never change.
  console.log("Historical excesses:", excesses);
}

export async function run(_logger: winston.Logger): Promise<void> {
  const baseSigner: Wallet = await getSigner();
  await runScript(_logger, baseSigner);
}

// eslint-disable-next-line no-process-exit
run(Logger).then(() => process.exit(0));

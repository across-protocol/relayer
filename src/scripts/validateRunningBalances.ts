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
  getRefund,
} from "../utils";
import {
  constructSpokePoolClientsForFastDataworker,
  updateDataworkerClients,
} from "../dataworker/DataworkerClientHelper";
import { createDataworker } from "../dataworker";
import { SpokePoolClient } from "../clients";
import { getWidestPossibleExpectedBlockRange } from "../dataworker/PoolRebalanceUtils";
import { getBlockForChain, getEndBlockBuffers } from "../dataworker/DataworkerUtils";
import { ProposedRootBundle, RelayData, SpokePoolClientsByChain } from "../interfaces";

config();
let logger: winston.Logger;

const slowRootCache = {};

export async function runScript(_logger: winston.Logger, baseSigner: Wallet): Promise<void> {
  logger = _logger;

  const { clients, dataworker, config } = await createDataworker(logger, baseSigner);
  await updateDataworkerClients(clients, false);

  // Enable all networks so we can validate historical bundles. Comment this out if a disabled network has RPC issues
  // for some reason.
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
  const bundlesToValidate = 20; // Roughly 2 days worth of bundles.
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
              const previousLeafRefundAmount = previousLeafExecution.refundAmounts.reduce((a, b) => a.add(b), toBN(0));
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
                // This part might fail if the token is ETH since deposits of ETH do not emit Transfer events, so
                // in these cases the `tokenBalanceAtBundleEndBlock` might look artificially higher for this bundle.
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

          // Check if previous bundle has any slow fills that haven't executed by the time of the bundle end block.
          if (previousRelayedRootBundle.slowRelayRoot !== EMPTY_MERKLE_ROOT) {
            // Not many bundles are expected to have slow fills so we can load them as necessary.
            const { slowFills, bundleSpokePoolClients } = await _constructSlowRootForBundle(
              previousValidatedBundle,
              validatedBundles[x + 1 + 2],
              mostRecentValidatedBundle
            );
            // Compute how much the slow fill will execute by checking if any partial fills were sent after
            // the slow fill amount was sent to the spoke pool.
            const slowFillsForPoolRebalanceLeaf = slowFills.filter(
              (f) => f.destinationChainId === leaf.chainId && f.destinationToken === l2Token
            );
            if (slowFillsForPoolRebalanceLeaf.length > 0) {
              for (const slowFillForChain of slowFillsForPoolRebalanceLeaf) {
                const fillsForSameDeposit = bundleSpokePoolClients[slowFillForChain.destinationChainId]
                  .getFillsForOriginChain(slowFillForChain.originChainId)
                  .filter(
                    (f) =>
                      f.blockNumber <= bundleEndBlockForChain.toNumber() && f.depositId === slowFillForChain.depositId
                  );
                const amountSentForSlowFillLeftUnexecuted = slowFillForChain.amount.sub(
                  sortEventsDescending(fillsForSameDeposit)[0].totalFilledAmount
                );
                if (amountSentForSlowFillLeftUnexecuted.gt(0)) {
                  const deductionForSlowFill = getRefund(
                    amountSentForSlowFillLeftUnexecuted,
                    slowFillForChain.realizedLpFeePct
                  );
                  console.log(
                    `- subtracting leftover amount from previous bundle's unexecuted slow fill: ${fromWei(
                      deductionForSlowFill.toString(),
                      decimals
                    )}`
                  );
                  tokenBalanceAtBundleEndBlock = tokenBalanceAtBundleEndBlock.sub(deductionForSlowFill);
                }
              }
            }
          }
        }

        if (mostRecentValidatedBundle.slowRelayRoot !== EMPTY_MERKLE_ROOT) {
          // If bundle has slow fills in it, then these are funds that need to be taken out of the spoke pool balance.
          // The slow fill amount will be captured in the netSendAmount as a positive value, so we need to cancel that out.

          // Not many bundles are expected to have slow fills so we can load them as necessary.
          const { slowFills, bundleSpokePoolClients } = await _constructSlowRootForBundle(
            mostRecentValidatedBundle,
            validatedBundles[x + 1 + 1],
            mostRecentValidatedBundle
          );
          const slowFillsForPoolRebalanceLeaf = slowFills.filter(
            (f) => f.destinationChainId === leaf.chainId && f.destinationToken === l2Token
          );
          if (slowFillsForPoolRebalanceLeaf.length > 0) {
            for (const slowFillForChain of slowFillsForPoolRebalanceLeaf) {
              const fillsForSameDeposit = bundleSpokePoolClients[slowFillForChain.destinationChainId]
                .getFillsForOriginChain(slowFillForChain.originChainId)
                .filter((f) => f.depositId === slowFillForChain.depositId);
              const amountSentForSlowFill = slowFillForChain.amount.sub(
                sortEventsDescending(fillsForSameDeposit)[0].totalFilledAmount
              );
              if (amountSentForSlowFill.gt(0)) {
                const deductionForSlowFill = getRefund(amountSentForSlowFill, slowFillForChain.realizedLpFeePct);
                console.log(
                  `- subtracting amount sent for slow fill: ${fromWei(deductionForSlowFill.toString(), decimals)}`
                );
                tokenBalanceAtBundleEndBlock = tokenBalanceAtBundleEndBlock.sub(deductionForSlowFill);
              }
            }
          }
        }

        const relayedRoot = spokePoolClients[leaf.chainId].getExecutedRefunds(
          mostRecentValidatedBundle.relayerRefundRoot
        );

        // NOTE: There are several ways in which excess can be incorrect:
        // - A relayer refund leaf from a bundle more than 2 bundles ago has not been executed.
        // - A slow fill from a bundle more than 2 bundles ago has not been executed and has not been replaced
        // by a partial fill.
        // - A deposit from HubPool to Spoke took too long to arrive and those deposits are not trackable via
        // Transfer events where the sender is 0x0.
        let excess = toBN(tokenBalanceAtBundleEndBlock).add(netSendAmount).add(runningBalance);

        if (relayedRoot === undefined || relayedRoot[l2Token] === undefined) {
          console.log(`- No relayed root for chain ID ${leaf.chainId} and token ${l2Token}`);
        } else {
          const executedRelayerRefund = Object.values(relayedRoot[l2Token]).reduce((a, b) => a.add(b), toBN(0));
          excess = excess.sub(executedRelayerRefund);
          console.log(`- executedRelayerRefund: ${fromWei(executedRelayerRefund.toString(), decimals)}`);
        }

        // Excess should theoretically be 0 but can be positive due to past accounting errors in computing running
        // balances. If excess is negative, then that means L2 leaves are unexecuted and the protocol could be
        // stuck
        excesses[leaf.chainId][tokenInfo.symbol].push(fromWei(excess.toString(), decimals));
        console.log(`- tokenBalance: ${fromWei(tokenBalanceAtBundleEndBlock.toString(), decimals)}`);
        console.log(`- netSendAmount: ${fromWei(netSendAmount.toString(), decimals)}`);
        console.log(`- excess: ${fromWei(excess.toString(), decimals)}`);
        console.log(`- runningBalance: ${fromWei(runningBalance.toString(), decimals)}`);
        console.groupEnd();
      }
    }
    console.groupEnd();
  }
  // Print out historical excesses for chain ID and token to make it easy to see if excesses have changed.
  // They should never change.
  console.log("Historical excesses:", excesses);

  /**
   *
   * @param bundle The bundle we want to construct a slow root for.
   * @param olderBundle Some bundle older than `bundle` whose end blocks we'll use to as the fromBlocks
   * when constructing custom spoke pool clients to query slow fills for `bundle`.
   * @param futureBundle Some bundle newer than `bundle` whose end blocks we'll use to as the toBlocks
   */
  async function _constructSlowRootForBundle(
    bundle: ProposedRootBundle,
    olderBundle: ProposedRootBundle,
    futureBundle: ProposedRootBundle
  ): Promise<{ slowFills: RelayData[]; bundleSpokePoolClients: SpokePoolClientsByChain }> {
    // Construct custom spoke pool clients to query events needed to build slow roots.
    const spokeClientFromBlocks = Object.fromEntries(
      dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId) => {
        return [
          chainId,
          getBlockForChain(
            olderBundle.bundleEvaluationBlockNumbers.map((x) => x.toNumber()),
            chainId,
            dataworker.chainIdListForBundleEvaluationBlockNumbers
          ),
        ];
      })
    );
    const spokeClientToBlocks = Object.fromEntries(
      dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId) => {
        return [
          chainId,
          getBlockForChain(
            futureBundle.bundleEvaluationBlockNumbers.map((x) => x.toNumber()),
            chainId,
            dataworker.chainIdListForBundleEvaluationBlockNumbers
          ),
        ];
      })
    );
    const key = `${JSON.stringify(spokeClientFromBlocks)}-${JSON.stringify(spokeClientToBlocks)}`;
    if (!slowRootCache[key]) {
      const spokePoolClientsForBundle = await constructSpokePoolClientsForFastDataworker(
        winston.createLogger({
          level: "warn", // Set to warn or higher so it doesn't produce extra logs
          transports: [new winston.transports.Console()],
        }),
        clients.configStoreClient,
        config,
        baseSigner,
        spokeClientFromBlocks,
        spokeClientToBlocks
      );

      // Reconstruct bundle block range for bundle.
      const widestPossibleExpectedBlockRange = await getWidestPossibleExpectedBlockRange(
        dataworker.chainIdListForBundleEvaluationBlockNumbers,
        spokePoolClientsForBundle,
        getEndBlockBuffers(dataworker.chainIdListForBundleEvaluationBlockNumbers, dataworker.blockRangeEndBlockBuffer),
        clients,
        bundle.blockNumber
      );
      const blockRangesImpliedByBundleEndBlocks = widestPossibleExpectedBlockRange.map((blockRange, index) => [
        blockRange[0],
        bundle.bundleEvaluationBlockNumbers[index].toNumber(),
      ]);
      const output = {
        slowFills: (await dataworker.buildSlowRelayRoot(blockRangesImpliedByBundleEndBlocks, spokePoolClientsForBundle))
          .leaves,
        bundleSpokePoolClients: spokePoolClientsForBundle,
      };
      slowRootCache[key] = output;
      return output;
    } else return slowRootCache[key];
  }
}

export async function run(_logger: winston.Logger): Promise<void> {
  const baseSigner: Wallet = await getSigner();
  await runScript(_logger, baseSigner);
}

// eslint-disable-next-line no-process-exit
run(Logger).then(() => process.exit(0));

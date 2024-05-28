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
  bnZero,
  winston,
  config,
  Logger,
  toBN,
  Event,
  fromWei,
  isDefined,
  Contract,
  ERC20,
  getProvider,
  EMPTY_MERKLE_ROOT,
  sortEventsDescending,
  paginatedEventQuery,
  ZERO_ADDRESS,
  disconnectRedisClients,
  Signer,
  getSigner,
} from "../utils";
import { createDataworker } from "../dataworker";
import { getWidestPossibleExpectedBlockRange } from "../dataworker/PoolRebalanceUtils";
import { getBlockForChain, getEndBlockBuffers } from "../dataworker/DataworkerUtils";
import { ProposedRootBundle, SpokePoolClientsByChain, V3SlowFillLeaf } from "../interfaces";
import { CONTRACT_ADDRESSES, constructSpokePoolClientsWithStartBlocks, updateSpokePoolClients } from "../common";
import { createConsoleTransport } from "@uma/logger";

config();
let logger: winston.Logger;

const slowRootCache: Record<string, { slowFills: V3SlowFillLeaf[]; bundleSpokePoolClients: SpokePoolClientsByChain }> =
  {};

const expectedExcesses: { [chainId: number]: { [token: string]: number } } = {
  [10]: { ["USDC"]: 15.336508 }, // On May 4th, USDC was sent to the SpokePool here: https://optimistic.etherscan.io/tx/0x5f53293fe6a27ff9897d4dde445fd6aab46f841ca641befea48beef62014a549
  [42161]: { ["WBTC"]: 1.9988628 }, // On May 15th, WBTC slow fill was produced here that is not executed: https://etherscan.io/tx/0xe339869271cb4f558faedbf9beed6f5b5440d395367743e5f12b13a4c199bdd6
};

export async function runScript(_logger: winston.Logger, baseSigner: Signer): Promise<void> {
  logger = _logger;

  const { clients, dataworker, config } = await createDataworker(logger, baseSigner);

  // Throw out most recent bundle as its leaves might not have executed.
  const validatedBundles = sortEventsDescending(clients.hubPoolClient.getValidatedRootBundles()).slice(1);
  const excesses: { [chainId: number]: { [l1Token: string]: string[] } } = {};
  const bundlesToValidate = 5; // Roughly 12 hours worth of bundles.

  // Create spoke pool clients that only query events related to root bundle proposals and roots
  // being sent to L2s. Clients will load events from the endblocks set in `oldestBundleToLookupEventsFor`.
  const oldestBundleToLookupEventsFor = validatedBundles[bundlesToValidate + 4];
  const _oldestBundleEndBlocks = oldestBundleToLookupEventsFor.bundleEvaluationBlockNumbers.map((x) => x.toNumber());
  const oldestBundleEndBlocks = Object.fromEntries(
    dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId, i) => {
      // If chain wasn't active at time of the bundle, set from block to undefined which will set from blocks to the
      // spoke pool registration block this chain.
      if (i >= oldestBundleToLookupEventsFor.bundleEvaluationBlockNumbers.length) {
        return [chainId, undefined];
      }
      return [
        chainId,
        getBlockForChain(_oldestBundleEndBlocks, chainId, dataworker.chainIdListForBundleEvaluationBlockNumbers),
      ];
    })
  );
  const spokePoolClients = await _createSpokePoolClients(oldestBundleEndBlocks);
  await Promise.all(
    Object.values(spokePoolClients).map((client) => client.update(["RelayedRootBundle", "ExecutedRelayerRefundRoot"]))
  );

  for (let x = 0; x < bundlesToValidate; x++) {
    let mrkdwn = "";
    const mostRecentValidatedBundle = validatedBundles[x];
    mrkdwn += `Bundle proposed at ${mostRecentValidatedBundle.transactionHash}`;
    const followingBlockNumber =
      clients.hubPoolClient.getFollowingRootBundle(mostRecentValidatedBundle)?.blockNumber ||
      clients.hubPoolClient.latestBlockSearched;
    const poolRebalanceLeaves = clients.hubPoolClient.getExecutedLeavesForRootBundle(
      mostRecentValidatedBundle,
      followingBlockNumber
    );
    if (poolRebalanceLeaves.length !== mostRecentValidatedBundle.poolRebalanceLeafCount) {
      throw new Error("PoolRebalanceLeaves not executed for bundle");
    }

    for (const leaf of poolRebalanceLeaves) {
      if (spokePoolClients[leaf.chainId] === undefined) {
        continue;
      }
      for (let i = 0; i < leaf.l1Tokens.length; i++) {
        const l1Token = leaf.l1Tokens[i];
        const tokenInfo = clients.hubPoolClient.getTokenInfo(clients.hubPoolClient.chainId, l1Token);
        if (!excesses[leaf.chainId]) {
          excesses[leaf.chainId] = {};
        }
        if (!excesses[leaf.chainId][tokenInfo.symbol]) {
          excesses[leaf.chainId][tokenInfo.symbol] = [];
        }

        mrkdwn += `\n\tLeaf for chain ID ${leaf.chainId} and token ${tokenInfo.symbol} (${l1Token})`;
        const decimals = tokenInfo.decimals;
        const l2Token = clients.hubPoolClient.getL2TokenForL1TokenAtBlock(l1Token, leaf.chainId, followingBlockNumber);
        const l2TokenContract = new Contract(l2Token, ERC20.abi, await getProvider(leaf.chainId));
        const runningBalance = leaf.runningBalances[i];
        const netSendAmount = leaf.netSendAmounts[i];
        const bundleEndBlockForChain =
          mostRecentValidatedBundle.bundleEvaluationBlockNumbers[
            dataworker.chainIdListForBundleEvaluationBlockNumbers.indexOf(leaf.chainId)
          ];
        mrkdwn += `\n\t\t- Bundle end block: ${bundleEndBlockForChain.toNumber()}`;
        let tokenBalanceAtBundleEndBlock = await l2TokenContract.balanceOf(
          spokePoolClients[leaf.chainId].spokePool.address,
          {
            blockTag: bundleEndBlockForChain.toNumber(),
          }
        );

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
            mrkdwn += `\n\t\t- Previous leaf executed at block ${previousLeafExecution.blockNumber}`;
            const previousLeafExecutedAfterBundleEndBlockForChain =
              previousLeafExecution.blockNumber > bundleEndBlockForChain.toNumber();
            mrkdwn += `\n\t\t- Previous relayer refund leaf executed after bundle end block for chain: ${previousLeafExecutedAfterBundleEndBlockForChain}`;
            if (previousLeafExecutedAfterBundleEndBlockForChain) {
              const previousLeafRefundAmount = previousLeafExecution.refundAmounts.reduce((a, b) => a.add(b), bnZero);
              mrkdwn += `\n\t\t- Subtracting previous leaf's amountToReturn (${fromWei(
                previousLeafExecution.amountToReturn.toString(),
                decimals
              )}) and refunds (${fromWei(previousLeafRefundAmount.toString(), decimals)}) from token balance`;
              tokenBalanceAtBundleEndBlock = tokenBalanceAtBundleEndBlock
                .sub(previousLeafExecution.amountToReturn)
                .sub(previousLeafExecution.refundAmounts.reduce((a, b) => a.add(b), bnZero));
            }
          }

          // Make sure that previous root bundle's netSendAmount has been deposited into the spoke pool. We only
          // perform this check for these L2 chains because transfers from the hub pool to spoke
          // pools on those chains can take a variable amount of time, unlike transfers to the spoke pool on
          // mainnet. Additionally, deposits to those chains emit Transfer events where the to address
          // is the SpokePool address, making it easy to track.
          if (leaf.chainId !== clients.hubPoolClient.chainId) {
            const _followingBlockNumber =
              clients.hubPoolClient.getFollowingRootBundle(previousValidatedBundle)?.blockNumber ||
              clients.hubPoolClient.latestBlockSearched;
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
              mrkdwn += `\n\t\t- Previous net send amount: ${fromWei(previousNetSendAmount.toString(), decimals)}`;
              if (previousNetSendAmount.gt(bnZero)) {
                console.log(
                  `Looking for previous net send amount between  blocks ${previousBundleEndBlockForChain.toNumber()} and ${bundleEndBlockForChain.toNumber()}`
                );
                const spokePoolAddress = spokePoolClients[leaf.chainId].spokePool.address;
                let depositsToSpokePool: Event[];
                // Handle the case that L1-->L2 deposits for some chains for ETH do not emit Transfer events, but
                // emit other events instead. This is the case for OpStack chains which emit DepositFinalized events
                // including the L1 and L2 ETH (native gas token) addresses.
                if ([10, 8453].includes(leaf.chainId) && tokenInfo.symbol === "WETH") {
                  const ovmL2BridgeContractInfo = CONTRACT_ADDRESSES[leaf.chainId].ovmStandardBridge;
                  const ovmL2Bridge = new Contract(
                    ovmL2BridgeContractInfo.address,
                    ovmL2BridgeContractInfo.abi,
                    await getProvider(leaf.chainId)
                  );
                  depositsToSpokePool = (
                    await paginatedEventQuery(
                      ovmL2Bridge,
                      ovmL2Bridge.filters.DepositFinalized(
                        ZERO_ADDRESS, // L1 token
                        CONTRACT_ADDRESSES[leaf.chainId].eth.address, // L2 token
                        clients.hubPoolClient.hubPool.address // from
                      ),
                      {
                        fromBlock: previousBundleEndBlockForChain.toNumber(),
                        toBlock: bundleEndBlockForChain.toNumber(),
                        maxBlockLookBack: config.maxBlockLookBack[leaf.chainId],
                      }
                    )
                  ).filter((e) => e.args._amount.eq(previousNetSendAmount) && e.args._to === spokePoolAddress);
                } else {
                  // This part could be inaccurate if there is a duplicate Transfer event for the exact same amount
                  // to the SpokePool address. This is unlikely so we'll ignore it for now.
                  depositsToSpokePool = (
                    await paginatedEventQuery(
                      l2TokenContract,
                      l2TokenContract.filters.Transfer(undefined, spokePoolAddress),
                      {
                        fromBlock: previousBundleEndBlockForChain.toNumber(),
                        toBlock: bundleEndBlockForChain.toNumber(),
                        maxBlockLookBack: config.maxBlockLookBack[leaf.chainId],
                      }
                    )
                  ).filter((e) => e.args.value.eq(previousNetSendAmount));
                }
                if (depositsToSpokePool.length === 0) {
                  mrkdwn += `\n\t\t- Adding previous leaf's netSendAmount (${fromWei(
                    previousNetSendAmount.toString(),
                    decimals
                  )}) to token balance because it did not arrive at spoke pool before bundle end block.`;
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
            // Compute how much the slow fill will execute by checking if any fills were sent after the slow fill amount
            // was sent to the spoke pool. This would reduce the amount transferred when when the slow fill is executed.
            const slowFillsForPoolRebalanceLeaf = slowFills.filter(
              (f) => f.chainId === leaf.chainId && f.relayData.outputToken === l2Token
            );

            if (slowFillsForPoolRebalanceLeaf.length > 0) {
              for (const slowFillForChain of slowFillsForPoolRebalanceLeaf) {
                const destinationChainId = slowFillForChain.chainId;
                const fillsForSameDeposit = bundleSpokePoolClients[destinationChainId]
                  .getFillsForOriginChain(slowFillForChain.relayData.originChainId)
                  .filter(
                    (f) =>
                      f.blockNumber <= bundleEndBlockForChain.toNumber() &&
                      f.depositId === slowFillForChain.relayData.depositId
                  );

                const lastFill = sortEventsDescending(fillsForSameDeposit)[0];

                // For v3 slow fills if there is a matching fast fill, then the fill is completed.
                const unexecutedAmount = isDefined(lastFill) ? bnZero : slowFillForChain.updatedOutputAmount;
                if (unexecutedAmount.gt(bnZero)) {
                  mrkdwn += `\n\t\t- subtracting leftover amount from previous bundle's unexecuted slow fill: ${fromWei(
                    unexecutedAmount.toString(),
                    decimals
                  )}`;
                  tokenBalanceAtBundleEndBlock = tokenBalanceAtBundleEndBlock.sub(unexecutedAmount);
                }
              }
            }
          }
        }

        if (mostRecentValidatedBundle.slowRelayRoot !== EMPTY_MERKLE_ROOT) {
          // If bundle has slow fills in it, then these are funds that need to be taken out of the spoke pool balance.
          // The slow fill amount will be captured in the netSendAmount as a positive value, so we need to cancel that out.

          // Not many bundles are expected to have slow fills so we can load them as necessary.
          const { slowFills } = await _constructSlowRootForBundle(
            mostRecentValidatedBundle,
            validatedBundles[x + 1 + 2],
            mostRecentValidatedBundle
          );
          const slowFillsForPoolRebalanceLeaf = slowFills.filter(
            (f) => f.chainId === leaf.chainId && f.relayData.outputToken === l2Token
          );
          if (slowFillsForPoolRebalanceLeaf.length > 0) {
            for (const slowFillForChain of slowFillsForPoolRebalanceLeaf) {
              const amountSentForSlowFill = slowFillForChain.updatedOutputAmount;
              if (amountSentForSlowFill.gt(0)) {
                mrkdwn += `\n\t\t- subtracting amount sent for slow fill: ${fromWei(
                  amountSentForSlowFill.toString(),
                  decimals
                )}`;
                tokenBalanceAtBundleEndBlock = tokenBalanceAtBundleEndBlock.sub(amountSentForSlowFill);
              }
            }
          }
        }

        const relayedRoot = dataworker.clients.bundleDataClient.getExecutedRefunds(
          spokePoolClients[leaf.chainId],
          mostRecentValidatedBundle.relayerRefundRoot
        );

        // NOTE: There are several ways in which excess can be incorrect:
        // - A relayer refund leaf from a bundle more than 2 bundles ago has not been executed or never
        //   arrived at the L2.
        // - A slow fill from a bundle more than 2 bundles ago has not been executed and has not been replaced
        // by a partial fill.
        // - A deposit from HubPool to Spoke took too long to arrive and those deposits are not trackable via
        // Transfer events where the sender is 0x0.
        let excess = toBN(tokenBalanceAtBundleEndBlock).add(netSendAmount).add(runningBalance);

        if (relayedRoot === undefined || relayedRoot[l2Token] === undefined) {
          // There is a possibility that the relayer refund root does not contain a refund leaf for this chain Id x
          // token combination but it did have a non-zero netSendAmount in the pool rebalance leaf. This is possible
          // if the net send amount was used to pay out slow fill leaves. Therefore, we should
          // only throw an error here if the slow fill root was empty and net send amount was non-zero. In this
          // case there MIGHT be a relayer refund root. Its hard to figure out otherwise if there was a refund root
          // so there might be a false negative here where we don't subtract the refund leaf amount because we
          // can't find it and it legitimately wasn't relayed over yet.
          if (!netSendAmount.eq(0) && mostRecentValidatedBundle.slowRelayRoot === EMPTY_MERKLE_ROOT) {
            // We shouldn't get here for any bundle since we start with the i-1'th most recent bundle.
            // If so, then a relayed root message might have gotten stuck in a canonical bridge and we will
            // want to know about it.
            const formattedAmount = fromWei(netSendAmount.toString(), decimals);
            throw new Error(
              `No relayed refund root for chain ID ${leaf.chainId} and token ${l2Token} with netSendAmount ${formattedAmount}`
            );
          }
        } else {
          const executedRelayerRefund = Object.values(relayedRoot[l2Token]).reduce((a, b) => a.add(b), bnZero);
          excess = excess.sub(executedRelayerRefund);
          mrkdwn += `\n\t\t- executedRelayerRefund: ${fromWei(executedRelayerRefund.toString(), decimals)}`;
        }

        // Excess should theoretically be 0 but can be positive due to past accounting errors in computing running
        // balances. If excess is negative, then that means L2 leaves are unexecuted and the protocol could be
        // stuck
        excesses[leaf.chainId][tokenInfo.symbol].push(fromWei(excess.toString(), decimals));
        mrkdwn += `\n\t\t- tokenBalance: ${fromWei(tokenBalanceAtBundleEndBlock.toString(), decimals)}`;
        mrkdwn += `\n\t\t- netSendAmount: ${fromWei(netSendAmount.toString(), decimals)}`;
        mrkdwn += `\n\t\t- excess: ${fromWei(excess.toString(), decimals)}`;
        mrkdwn += `\n\t\t- runningBalance: ${fromWei(runningBalance.toString(), decimals)}`;
      }
    }
    logger.debug({
      at: "validateRunningBalances#index",
      message: `Bundle #${x} proposed at block ${mostRecentValidatedBundle.blockNumber}`,
      mrkdwn,
    });
  }

  // Print out historical excesses for chain ID and token to make it easy to see if excesses have changed.
  // They should never change.
  logger.debug({
    at: "validateRunningBalances#index",
    message: "Historical excesses",
    expectedExcesses,
    excesses,
  });
  const unexpectedExcess = Object.entries(excesses).some(([chainId, tokenExcesses]) => {
    return Object.entries(tokenExcesses).some(([l1Token, excesses]) => {
      // We only care about the latest excess, because sometimes excesses can appear in historical bundles
      // due to ordering of executing leaves. As long as the excess resets back to 0 eventually it is fine.
      const excess = Number(excesses[0]);
      // Subtract any expected excesses
      const excessForChain = excess - (expectedExcesses[Number(chainId)]?.[l1Token] ?? 0);
      return excessForChain > 0.05 || excessForChain < -0.05;
    });
  });
  if (unexpectedExcess) {
    logger.error({
      at: "validateRunningBalances#index",
      message: "Unexpected excess found",
    });
  }

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
  ): Promise<{ slowFills: V3SlowFillLeaf[]; bundleSpokePoolClients: SpokePoolClientsByChain }> {
    // Construct custom spoke pool clients to query events needed to build slow roots.
    const spokeClientFromBlocks = Object.fromEntries(
      dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId, i) => {
        // If chain was not active at the time of the older bundle, then set from blocks to undefined
        // which will load events since the registration block for the chain.
        if (i >= olderBundle.bundleEvaluationBlockNumbers.length) {
          return [chainId, undefined];
        }
        return [
          chainId,
          getBlockForChain(
            olderBundle.bundleEvaluationBlockNumbers.map((x) => x.toNumber()),
            Number(chainId),
            dataworker.chainIdListForBundleEvaluationBlockNumbers
          ),
        ];
      })
    );
    const spokeClientToBlocks = Object.fromEntries(
      dataworker.chainIdListForBundleEvaluationBlockNumbers.map((chainId, i) => {
        // If chain was not active at the time of the future bundle, then set to blocks to undefined
        // which will load events until latest
        if (i >= futureBundle.bundleEvaluationBlockNumbers.length) {
          return [chainId, undefined];
        }
        return [
          chainId,
          getBlockForChain(
            futureBundle.bundleEvaluationBlockNumbers.map((x) => x.toNumber()),
            Number(chainId),
            dataworker.chainIdListForBundleEvaluationBlockNumbers
          ),
        ];
      })
    );
    const key = `${JSON.stringify(spokeClientFromBlocks)}-${JSON.stringify(spokeClientToBlocks)}`;
    if (!slowRootCache[key]) {
      const spokePoolClientsForBundle = await constructSpokePoolClientsWithStartBlocks(
        winston.createLogger({
          level: "debug",
          transports: [createConsoleTransport()],
        }),
        clients.hubPoolClient,
        config,
        baseSigner,
        spokeClientFromBlocks,
        spokeClientToBlocks
      );
      await updateSpokePoolClients(spokePoolClientsForBundle, [
        "RelayedRootBundle",
        "ExecutedRelayerRefundRoot",
        "V3FundsDeposited",
        "RequestedV3SlowFill",
        "FilledV3Relay",
      ]);

      // Reconstruct bundle block range for bundle.
      const mainnetBundleEndBlock = getBlockForChain(
        bundle.bundleEvaluationBlockNumbers.map((x) => x.toNumber()),
        clients.hubPoolClient.chainId,
        dataworker.chainIdListForBundleEvaluationBlockNumbers
      );
      const widestPossibleExpectedBlockRange = getWidestPossibleExpectedBlockRange(
        clients.configStoreClient.getChainIdIndicesForBlock(mainnetBundleEndBlock),
        spokePoolClientsForBundle,
        getEndBlockBuffers(dataworker.chainIdListForBundleEvaluationBlockNumbers, dataworker.blockRangeEndBlockBuffer),
        clients,
        bundle.blockNumber,
        clients.configStoreClient.getEnabledChains(mainnetBundleEndBlock)
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
    } else {
      return slowRootCache[key];
    }
  }

  /**
   * @notice Create SpokePool clients that are configured to query events from their deployment blocks.
   * @dev Clients are only created for chains not on disabled chain list.
   * @returns A dictionary of chain ID to SpokePoolClient.
   */
  async function _createSpokePoolClients(fromBlocks: { [chainId: number]: number }) {
    return constructSpokePoolClientsWithStartBlocks(logger, clients.hubPoolClient, config, baseSigner, fromBlocks, {});
  }
}

export async function run(_logger: winston.Logger): Promise<void> {
  try {
    // This script inherits the TokenClient, and it attempts to update token approvals. The disputer already has the
    // necessary token approvals in place, so use its address. nb. This implies the script can only be used on mainnet.
    const voidSigner = "0xf7bAc63fc7CEaCf0589F25454Ecf5C2ce904997c";
    const baseSigner = await getSigner({ keyType: "void", cleanEnv: true, roAddress: voidSigner });
    await runScript(_logger, baseSigner);
  } finally {
    await disconnectRedisClients(logger);
  }
}

// eslint-disable-next-line no-process-exit
void run(Logger).then(() => process.exit(0));

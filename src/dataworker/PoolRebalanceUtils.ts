// eslint-disable-next-line node/no-missing-import
import { FundsDepositedEvent } from "@across-protocol/sdk-v2/dist/typechain";
import { ConfigStoreClient, HubPoolClient, SpokePoolClient } from "../clients";
import { Clients } from "../common";
import * as interfaces from "../interfaces";
import {
  BigNumberForToken,
  PendingRootBundle,
  PoolRebalanceLeaf,
  RelayerRefundLeaf,
  RunningBalances,
  SlowFillLeaf,
  SpokePoolClientsByChain,
  SpokePoolTargetBalance,
  UnfilledDeposit,
} from "../interfaces";
import {
  AnyObject,
  BigNumber,
  MerkleTree,
  assign,
  compareAddresses,
  convertFromWei,
  formatFeePct,
  getFillDataForSlowFillFromPreviousRootBundle,
  getRefund,
  shortenHexString,
  shortenHexStrings,
  toBN,
  toBNWei,
  winston,
} from "../utils";
import { DataworkerClients } from "./DataworkerClientHelper";

export function updateRunningBalance(
  runningBalances: interfaces.RunningBalances,
  l2ChainId: number,
  l1Token: string,
  updateAmount: BigNumber
): void {
  // Initialize dictionary if empty.
  if (!runningBalances[l2ChainId]) {
    runningBalances[l2ChainId] = {};
  }
  const runningBalance = runningBalances[l2ChainId][l1Token];
  if (runningBalance) {
    runningBalances[l2ChainId][l1Token] = runningBalance.add(updateAmount);
  } else {
    runningBalances[l2ChainId][l1Token] = updateAmount;
  }
}

export function updateRunningBalanceForFill(
  endBlockForMainnet: number,
  runningBalances: interfaces.RunningBalances,
  hubPoolClient: HubPoolClient,
  fill: interfaces.FillWithBlock,
  updateAmount: BigNumber
): void {
  const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
    fill.destinationChainId,
    fill.destinationToken,
    endBlockForMainnet
  );
  updateRunningBalance(runningBalances, fill.destinationChainId, l1TokenCounterpart, updateAmount);
}

export function updateRunningBalanceForDeposit(
  runningBalances: interfaces.RunningBalances,
  hubPoolClient: HubPoolClient,
  deposit: interfaces.DepositWithBlock,
  updateAmount: BigNumber
): void {
  const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
    deposit.originChainId,
    deposit.originToken,
    deposit.quoteBlockNumber
  );
  updateRunningBalance(runningBalances, deposit.originChainId, l1TokenCounterpart, updateAmount);
}

export function updateRunningBalanceForEarlyDeposit(
  runningBalances: interfaces.RunningBalances,
  hubPoolClient: HubPoolClient,
  deposit: FundsDepositedEvent,
  updateAmount: BigNumber
): void {
  const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
    Number(deposit.args.originChainId.toString()),
    deposit.args.originToken,
    // TODO: this must be handled s.t. it doesn't depend on when this is run.
    // For now, tokens do not change their mappings often, so this will work, but
    // to keep the system resilient, this must be updated.
    hubPoolClient.latestBlockNumber
  );
  updateRunningBalance(
    runningBalances,
    Number(deposit.args.originChainId.toString()),
    l1TokenCounterpart,
    updateAmount
  );
}

export function addLastRunningBalance(
  latestMainnetBlock: number,
  runningBalances: interfaces.RunningBalances,
  hubPoolClient: HubPoolClient
): void {
  Object.keys(runningBalances).forEach((repaymentChainId) => {
    Object.keys(runningBalances[repaymentChainId]).forEach((l1TokenAddress) => {
      const { runningBalance } = hubPoolClient.getRunningBalanceBeforeBlockForChain(
        latestMainnetBlock,
        Number(repaymentChainId),
        l1TokenAddress
      );
      if (!runningBalance.eq(toBN(0))) {
        updateRunningBalance(runningBalances, Number(repaymentChainId), l1TokenAddress, runningBalance);
      }
    });
  });
}

export function initializeRunningBalancesFromRelayerRepayments(
  runningBalances: RunningBalances,
  realizedLpFees: RunningBalances,
  latestMainnetBlock: number,
  hubPoolClient: HubPoolClient,
  fillsToRefund: interfaces.FillsToRefund
): void {
  Object.entries(fillsToRefund).forEach(([_repaymentChainId, fillsForChain]) => {
    const repaymentChainId = Number(_repaymentChainId);
    Object.entries(fillsForChain).forEach(
      ([l2TokenAddress, { realizedLpFees: totalRealizedLpFee, totalRefundAmount }]) => {
        const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
          repaymentChainId,
          l2TokenAddress,
          latestMainnetBlock
        );

        // Realized LP fees is only affected by relayer repayments so we'll return a brand new dictionary of those
        // mapped to each { repaymentChainId, repaymentToken } combination.
        assign(realizedLpFees, [repaymentChainId, l1TokenCounterpart], totalRealizedLpFee);

        // Add total repayment amount to running balances. Note: totalRefundAmount won't exist for chains that
        // only had slow fills, so we should explicitly check for it.
        if (totalRefundAmount) {
          assign(runningBalances, [repaymentChainId, l1TokenCounterpart], totalRefundAmount);
        } else {
          assign(runningBalances, [repaymentChainId, l1TokenCounterpart], toBN(0));
        }
      }
    );
  });
}

export function addSlowFillsToRunningBalances(
  latestMainnetBlock: number,
  runningBalances: interfaces.RunningBalances,
  hubPoolClient: HubPoolClient,
  unfilledDeposits: UnfilledDeposit[]
): void {
  unfilledDeposits.forEach((unfilledDeposit) => {
    const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
      unfilledDeposit.deposit.originChainId,
      unfilledDeposit.deposit.originToken,
      latestMainnetBlock
    );
    updateRunningBalance(
      runningBalances,
      unfilledDeposit.deposit.destinationChainId,
      l1TokenCounterpart,
      getRefund(unfilledDeposit.unfilledAmount, unfilledDeposit.deposit.realizedLpFeePct)
    );
  });
}

// TODO: Is summing up absolute values really the best way to compute a root bundle's "volume"? Said another way,
// how do we measure a root bundle's "impact" or importance?
export function computePoolRebalanceUsdVolume(leaves: PoolRebalanceLeaf[], clients: DataworkerClients): BigNumber {
  return leaves.reduce((result: BigNumber, poolRebalanceLeaf) => {
    return poolRebalanceLeaf.l1Tokens.reduce((sum: BigNumber, l1Token: string, index: number) => {
      const netSendAmount = poolRebalanceLeaf.netSendAmounts[index];
      const volume = netSendAmount.abs();
      const tokenPriceInUsd = clients.profitClient.getPriceOfToken(l1Token);
      const volumeInUsd = volume.mul(tokenPriceInUsd).div(toBNWei(1));
      const l1TokenInfo = clients.hubPoolClient.getTokenInfoForL1Token(l1Token);
      const volumeInUsdScaled = volumeInUsd.mul(toBN(10).pow(18 - l1TokenInfo.decimals));

      return sum.add(volumeInUsdScaled);
    }, result);
  }, toBN(0));
}

export async function subtractExcessFromPreviousSlowFillsFromRunningBalances(
  mainnetBundleEndBlock: number,
  runningBalances: interfaces.RunningBalances,
  hubPoolClient: HubPoolClient,
  spokePoolClientsByChain: SpokePoolClientsByChain,
  allValidFills: interfaces.FillWithBlock[],
  allValidFillsInRange: interfaces.FillWithBlock[]
): Promise<AnyObject> {
  const excesses = {};
  // We need to subtract excess from any fills that might replaced a slow fill sent to the fill destination chain.
  // This can only happen if the fill was the last fill for a deposit. Otherwise, its still possible that the slow fill
  // for the deposit can be executed, so we'll defer the excess calculation until the hypothetical slow fill executes.
  // In addition to fills that are not the last fill for a deposit, we can ignore fills that completely fill a deposit
  // as the first fill. These fills could never have triggered a deposit since there were no partial fills for it.
  // This assumption depends on the rule that slow fills can only be sent after a partial fill for a non zero amount
  // of the deposit. This is why "1 wei" fills are important, otherwise we'd never know which fills originally
  // triggered a slow fill payment to be sent to the destination chain.
  await Promise.all(
    allValidFillsInRange
      .filter((fill) => fill.totalFilledAmount.eq(fill.amount) && !fill.fillAmount.eq(fill.amount))
      .map(async (fill: interfaces.FillWithBlock) => {
        const { lastMatchingFillInSameBundle, rootBundleEndBlockContainingFirstFill } =
          await getFillDataForSlowFillFromPreviousRootBundle(
            hubPoolClient.latestBlockNumber,
            fill,
            allValidFills,
            hubPoolClient,
            spokePoolClientsByChain
          );

        // Now that we have the last fill sent in a previous root bundle that also sent a slow fill, we can compute
        // the excess that we need to decrease running balances by. This excess only exists in the case where the
        // current fill completed a deposit. There will be an excess if (1) the slow fill was never executed, and (2)
        // the slow fill was executed, but not before some partial fills were sent.

        // Note, if there is NO fill from a previous root bundle for the same deposit as this fill, then there has been
        // no slow fill payment sent to the spoke pool yet, so we can exit early.
        if (lastMatchingFillInSameBundle === undefined) {
          return;
        }

        // If first fill for this deposit is in this epoch, then no slow fill has been sent so we can ignore this fill.
        // We can check this by searching for a ProposeRootBundle event with a bundle block range that contains the
        // first fill for this deposit. If it is the same as the ProposeRootBundle event containing the
        // current fill, then the first fill is in the current bundle and we can exit early.
        const rootBundleEndBlockContainingFullFill = hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(
          hubPoolClient.latestBlockNumber,
          fill.blockNumber,
          fill.destinationChainId
        );
        if (rootBundleEndBlockContainingFirstFill === rootBundleEndBlockContainingFullFill) {
          return;
        }

        // Recompute how much the matched root bundle sent for this slow fill.
        const preFeeAmountSentForSlowFill = lastMatchingFillInSameBundle.amount.sub(
          lastMatchingFillInSameBundle.totalFilledAmount
        );

        // If this fill is a slow fill, then the excess remaining in the contract is equal to the amount sent originally
        // for this slow fill, and the amount filled. If this fill was not a slow fill, then that means the slow fill
        // was never sent, so we need to send the full slow fill back.
        const excess = getRefund(
          fill.updatableRelayData.isSlowRelay
            ? preFeeAmountSentForSlowFill.sub(fill.fillAmount)
            : preFeeAmountSentForSlowFill,
          fill.realizedLpFeePct
        );
        if (excess.eq(toBN(0))) {
          return;
        }

        // Log excesses for debugging since this logic is so complex.
        if (excesses[fill.destinationChainId] === undefined) {
          excesses[fill.destinationChainId] = {};
        }
        if (excesses[fill.destinationChainId][fill.destinationToken] === undefined) {
          excesses[fill.destinationChainId][fill.destinationToken] = [];
        }
        excesses[fill.destinationChainId][fill.destinationToken].push({
          excess: excess.toString(),
          lastMatchingFillInSameBundle,
          rootBundleEndBlockContainingFirstFill,
          rootBundleEndBlockContainingFullFill: rootBundleEndBlockContainingFullFill
            ? rootBundleEndBlockContainingFullFill
            : "N/A",
          finalFill: fill,
        });

        updateRunningBalanceForFill(mainnetBundleEndBlock, runningBalances, hubPoolClient, fill, excess.mul(toBN(-1)));
      })
  );

  // Sort excess entries by block number, most recent first.
  Object.keys(excesses).forEach((chainId) => {
    Object.keys(excesses[chainId]).forEach((token) => {
      excesses[chainId][token] = excesses[chainId][token].sort(
        (ex, ey) => ey.finalFill.blockNumber - ex.finalFill.blockNumber
      );
    });
  });
  return excesses;
}

export function constructPoolRebalanceLeaves(
  latestMainnetBlock: number,
  runningBalances: interfaces.RunningBalances,
  realizedLpFees: interfaces.RunningBalances,
  configStoreClient: ConfigStoreClient,
  maxL1TokenCount?: number,
  tokenTransferThreshold?: BigNumberForToken,
  incentivePoolBalances?: interfaces.RunningBalances,
  netSendAmounts?: interfaces.RunningBalances,
  ubaMode = false
): interfaces.PoolRebalanceLeaf[] {
  // Create one leaf per L2 chain ID. First we'll create a leaf with all L1 tokens for each chain ID, and then
  // we'll split up any leaves with too many L1 tokens.
  const leaves: interfaces.PoolRebalanceLeaf[] = [];
  Object.keys(runningBalances)
    // Leaves should be sorted by ascending chain ID
    .sort((chainIdA, chainIdB) => Number(chainIdA) - Number(chainIdB))
    .map((chainId: string) => {
      // Sort addresses.
      const sortedL1Tokens = Object.keys(runningBalances[chainId]).sort((addressA, addressB) => {
        return compareAddresses(addressA, addressB);
      });

      // This begins at 0 and increments for each leaf for this { chainId, L1Token } combination.
      let groupIndexForChainId = 0;

      // Split addresses into multiple leaves if there are more L1 tokens than allowed per leaf.
      const maxL1TokensPerLeaf =
        maxL1TokenCount || configStoreClient.getMaxRefundCountForRelayerRefundLeafForBlock(latestMainnetBlock);
      for (let i = 0; i < sortedL1Tokens.length; i += maxL1TokensPerLeaf) {
        const l1TokensToIncludeInThisLeaf = sortedL1Tokens.slice(i, i + maxL1TokensPerLeaf);

        const transferThresholds = l1TokensToIncludeInThisLeaf.map(
          (l1Token) =>
            tokenTransferThreshold[l1Token] ||
            configStoreClient.getTokenTransferThresholdForBlock(l1Token, latestMainnetBlock)
        );

        const spokeTargetBalances = l1TokensToIncludeInThisLeaf.map((l1Token) =>
          configStoreClient.getSpokeTargetBalancesForBlock(l1Token, Number(chainId), latestMainnetBlock)
        );

        // Build leaves using running balances and realized lp fees data for l1Token + chain, or default to
        // zero if undefined.
        const leafBundleLpFees = l1TokensToIncludeInThisLeaf.map((l1Token) => {
          if (realizedLpFees[chainId]?.[l1Token]) {
            return realizedLpFees[chainId][l1Token];
          } else {
            return toBN(0);
          }
        });
        const leafNetSendAmounts = l1TokensToIncludeInThisLeaf.map((l1Token, index) => {
          if (ubaMode && netSendAmounts?.[chainId] && netSendAmounts[chainId][l1Token]) {
            return netSendAmounts[chainId][l1Token];
          } else if (runningBalances[chainId] && runningBalances[chainId][l1Token]) {
            return getNetSendAmountForL1Token(
              transferThresholds[index],
              spokeTargetBalances[index],
              runningBalances[chainId][l1Token]
            );
          } else {
            return toBN(0);
          }
        });
        const leafRunningBalances = l1TokensToIncludeInThisLeaf.map((l1Token, index) => {
          if (runningBalances[chainId]?.[l1Token]) {
            // If UBA bundle, then we don't need to compare running balance to transfer thresholds or
            // spoke target balances, as the UBA client already performs similar logic to set the running balances
            // for each flow. In the UBA, simply take the running balances computed by the UBA client.
            if (ubaMode) {
              return runningBalances[chainId][l1Token];
            } else {
              return getRunningBalanceForL1Token(
                transferThresholds[index],
                spokeTargetBalances[index],
                runningBalances[chainId][l1Token]
              );
            }
          } else {
            return toBN(0);
          }
        });
        const incentiveBalances =
          ubaMode &&
          incentivePoolBalances &&
          l1TokensToIncludeInThisLeaf.map((l1Token) => {
            if (incentivePoolBalances[chainId]?.[l1Token]) {
              return incentivePoolBalances[chainId][l1Token];
            } else {
              return toBN(0);
            }
          });

        leaves.push({
          chainId: Number(chainId),
          bundleLpFees: leafBundleLpFees,
          netSendAmounts: leafNetSendAmounts,
          runningBalances: leafRunningBalances.concat(incentivePoolBalances ? incentiveBalances : []),
          groupIndex: groupIndexForChainId++,
          leafId: leaves.length,
          l1Tokens: l1TokensToIncludeInThisLeaf,
        });
      }
    });
  return leaves;
}

// Note: this function computes the intended transfer amount before considering the transfer threshold.
// A positive number indicates a transfer from hub to spoke.
export function computeDesiredTransferAmountToSpoke(
  runningBalance: BigNumber,
  spokePoolTargetBalance: SpokePoolTargetBalance
): BigNumber {
  // Transfer is always desired if hub owes spoke.
  if (runningBalance.gte(0)) {
    return runningBalance;
  }

  // Running balance is negative, but its absolute value is less than the spoke pool target balance threshold.
  // In this case, we transfer nothing.
  if (runningBalance.abs().lt(spokePoolTargetBalance.threshold)) {
    return toBN(0);
  }

  // We are left with the case where the spoke pool is beyond the threshold.
  // A transfer needs to be initiated to bring it down to the target.
  const transferSize = runningBalance.abs().sub(spokePoolTargetBalance.target);

  // If the transferSize is < 0, this indicates that the target is still above the running balance.
  // This can only happen if the threshold is less than the target. This is likely due to a misconfiguration.
  // In this case, we transfer nothing until the target is exceeded.
  if (transferSize.lt(0)) {
    return toBN(0);
  }

  // Negate the transfer size because a transfer from spoke to hub is indicated by a negative number.
  return transferSize.mul(-1);
}

// If the running balance is greater than the token transfer threshold, then set the net send amount
// equal to the running balance and reset the running balance to 0. Otherwise, the net send amount should be
// 0, indicating that we do not want the data worker to trigger a token transfer between hub pool and spoke
// pool when executing this leaf.
export function getNetSendAmountForL1Token(
  transferThreshold: BigNumber,
  spokePoolTargetBalance: SpokePoolTargetBalance,
  runningBalance: BigNumber
): BigNumber {
  const desiredTransferAmount = computeDesiredTransferAmountToSpoke(runningBalance, spokePoolTargetBalance);
  return desiredTransferAmount.abs().gte(transferThreshold) ? desiredTransferAmount : toBN(0);
}

export function getRunningBalanceForL1Token(
  transferThreshold: BigNumber,
  spokePoolTargetBalance: SpokePoolTargetBalance,
  runningBalance: BigNumber
): BigNumber {
  const desiredTransferAmount = computeDesiredTransferAmountToSpoke(runningBalance, spokePoolTargetBalance);
  return desiredTransferAmount.abs().lt(transferThreshold) ? runningBalance : runningBalance.sub(desiredTransferAmount);
}

// This returns a possible next block range that could be submitted as a new root bundle, or used as a reference
// when evaluating  pending root bundle. The block end numbers must be less than the latest blocks for each chain ID
// (because we can't evaluate events in the future), and greater than the the expected start blocks, which are the
// greater of 0 and the latest bundle end block for an executed root bundle proposal + 1.
export function getWidestPossibleExpectedBlockRange(
  chainIdListForBundleEvaluationBlockNumbers: number[],
  spokeClients: { [chainId: number]: SpokePoolClient },
  endBlockBuffers: number[],
  clients: Clients,
  latestMainnetBlock: number,
  enabledChains: number[]
): number[][] {
  // We impose a buffer on the head of the chain to increase the probability that the received blocks are final.
  // Reducing the latest block that we query also gives partially filled deposits slightly more buffer for relayers
  // to fully fill the deposit and reduces the chance that the data worker includes a slow fill payment that gets
  // filled during the challenge period.
  const latestPossibleBundleEndBlockNumbers = chainIdListForBundleEvaluationBlockNumbers.map(
    (chainId: number, index) =>
      spokeClients[chainId] && Math.max(spokeClients[chainId].latestBlockNumber - endBlockBuffers[index], 0)
  );
  return chainIdListForBundleEvaluationBlockNumbers.map((chainId: number, index) => {
    const lastEndBlockForChain = clients.hubPoolClient.getLatestBundleEndBlockForChain(
      chainIdListForBundleEvaluationBlockNumbers,
      latestMainnetBlock,
      chainId
    );

    // If chain is disabled, re-use the latest bundle end block for the chain as both the start
    // and end block.
    if (!enabledChains.includes(chainId)) {
      return [lastEndBlockForChain, lastEndBlockForChain];
    } else {
      // If the latest block hasn't advanced enough from the previous proposed end block, then re-use it. It will
      // be regarded as disabled by the Dataworker clients. Otherwise, add 1 to the previous proposed end block.
      if (lastEndBlockForChain >= latestPossibleBundleEndBlockNumbers[index]) {
        // @dev: Without this check, then `getNextBundleStartBlockNumber` could return `latestBlock+1` even when the
        // latest block for the chain hasn't advanced, resulting in an invalid range being produced.
        return [lastEndBlockForChain, lastEndBlockForChain];
      } else {
        // Chain has advanced far enough including the buffer, return range from previous proposed end block + 1 to
        // latest block for chain minus buffer.
        return [
          clients.hubPoolClient.getNextBundleStartBlockNumber(
            chainIdListForBundleEvaluationBlockNumbers,
            latestMainnetBlock,
            chainId
          ),
          latestPossibleBundleEndBlockNumbers[index],
        ];
      }
    }
  });
}

export function generateMarkdownForDisputeInvalidBundleBlocks(
  chainIdListForBundleEvaluationBlockNumbers: number[],
  pendingRootBundle: PendingRootBundle,
  widestExpectedBlockRange: number[][],
  buffers: number[]
): string {
  const getBlockRangePretty = (blockRange: number[][] | number[]) => {
    let bundleBlockRangePretty = "";
    chainIdListForBundleEvaluationBlockNumbers.forEach((chainId, index) => {
      bundleBlockRangePretty += `\n\t\t${chainId}: ${JSON.stringify(blockRange[index])}`;
    });
    return bundleBlockRangePretty;
  };
  return (
    "Disputed pending root bundle because of invalid bundle blocks:" +
    `\n\t*Widest possible expected block range*:${getBlockRangePretty(widestExpectedBlockRange)}` +
    `\n\t*Buffers to end blocks*:${getBlockRangePretty(buffers)}` +
    `\n\t*Pending end blocks*:${getBlockRangePretty(pendingRootBundle.bundleEvaluationBlockNumbers)}`
  );
}

export function generateMarkdownForDispute(pendingRootBundle: PendingRootBundle): string {
  return (
    "Disputed pending root bundle:" +
    `\n\tPoolRebalance leaf count: ${pendingRootBundle.unclaimedPoolRebalanceLeafCount}` +
    `\n\tPoolRebalance root: ${shortenHexString(pendingRootBundle.poolRebalanceRoot)}` +
    `\n\tRelayerRefund root: ${shortenHexString(pendingRootBundle.relayerRefundRoot)}` +
    `\n\tSlowRelay root: ${shortenHexString(pendingRootBundle.slowRelayRoot)}` +
    `\n\tProposer: ${shortenHexString(pendingRootBundle.proposer)}`
  );
}

export function isChainDisabled(blockRangeForChain: number[]): boolean {
  return blockRangeForChain[0] === blockRangeForChain[1];
}

export function generateMarkdownForRootBundle(
  hubPoolClient: HubPoolClient,
  chainIdListForBundleEvaluationBlockNumbers: number[],
  hubPoolChainId: number,
  bundleBlockRange: number[][],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  poolRebalanceLeaves: any[],
  poolRebalanceRoot: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  relayerRefundLeaves: any[],
  relayerRefundRoot: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  slowRelayLeaves: any[],
  slowRelayRoot: string
): string {
  // Create helpful logs to send to slack transport
  let bundleBlockRangePretty = "";
  bundleBlockRange.forEach((_blockRange, index) => {
    const chainId = chainIdListForBundleEvaluationBlockNumbers[index];
    bundleBlockRangePretty += `\n\t\t${chainId}: ${JSON.stringify(bundleBlockRange[index])}${
      isChainDisabled(bundleBlockRange[index]) ? " 🥶" : ""
    }`;
  });

  const convertTokenListFromWei = (chainId: number, tokenAddresses: string[], weiVals: string[]) => {
    return tokenAddresses.map((token, index) => {
      const { decimals } = hubPoolClient.getTokenInfo(chainId, token);
      return convertFromWei(weiVals[index], decimals);
    });
  };
  const convertTokenAddressToSymbol = (chainId: number, tokenAddress: string) => {
    return hubPoolClient.getTokenInfo(chainId, tokenAddress).symbol;
  };
  const convertL1TokenAddressesToSymbols = (l1Tokens: string[]) => {
    return l1Tokens.map((l1Token) => {
      return convertTokenAddressToSymbol(hubPoolChainId, l1Token);
    });
  };
  let poolRebalanceLeavesPretty = "";
  poolRebalanceLeaves.forEach((leaf, index) => {
    // Shorten keys for ease of reading from Slack.
    delete leaf.leafId;
    leaf.groupId = leaf.groupIndex;
    delete leaf.groupIndex;
    leaf.bundleLpFees = convertTokenListFromWei(hubPoolChainId, leaf.l1Tokens, leaf.bundleLpFees);
    leaf.runningBalances = convertTokenListFromWei(hubPoolChainId, leaf.l1Tokens, leaf.runningBalances);
    leaf.netSendAmounts = convertTokenListFromWei(hubPoolChainId, leaf.l1Tokens, leaf.netSendAmounts);
    leaf.l1Tokens = convertL1TokenAddressesToSymbols(leaf.l1Tokens);
    poolRebalanceLeavesPretty += `\n\t\t\t${index}: ${JSON.stringify(leaf)}`;
  });

  let relayerRefundLeavesPretty = "";
  relayerRefundLeaves.forEach((leaf, index) => {
    // Shorten keys for ease of reading from Slack.
    delete leaf.leafId;
    leaf.amountToReturn = convertFromWei(
      leaf.amountToReturn,
      hubPoolClient.getTokenInfo(leaf.chainId, leaf.l2TokenAddress).decimals
    );
    leaf.refundAmounts = convertTokenListFromWei(
      leaf.chainId,
      Array(leaf.refundAmounts.length).fill(leaf.l2TokenAddress),
      leaf.refundAmounts
    );
    leaf.l2Token = convertTokenAddressToSymbol(leaf.chainId, leaf.l2TokenAddress);
    delete leaf.l2TokenAddress;
    leaf.refundAddresses = shortenHexStrings(leaf.refundAddresses);
    relayerRefundLeavesPretty += `\n\t\t\t${index}: ${JSON.stringify(leaf)}`;
  });

  let slowRelayLeavesPretty = "";
  slowRelayLeaves.forEach((leaf, index) => {
    const decimalsForDestToken = hubPoolClient.getTokenInfo(
      leaf.relayData.destinationChainId,
      leaf.relayData.destinationToken
    ).decimals;
    // Shorten keys for ease of reading from Slack.
    leaf.relayData.originChain = leaf.relayData.originChainId;
    leaf.relayData.destinationChain = leaf.relayData.destinationChainId;
    leaf.relayData.depositor = shortenHexString(leaf.relayData.depositor);
    leaf.relayData.recipient = shortenHexString(leaf.relayData.recipient);
    leaf.relayData.destToken = convertTokenAddressToSymbol(
      leaf.relayData.destinationChainId,
      leaf.relayData.destinationToken
    );
    leaf.relayData.amount = convertFromWei(leaf.relayData.amount, decimalsForDestToken);
    // Fee decimals is always 18. 1e18 = 100% so 1e16 = 1%.
    leaf.relayData.realizedLpFee = `${formatFeePct(leaf.relayData.realizedLpFeePct)}%`;
    leaf.relayData.relayerFee = `${formatFeePct(leaf.relayData.relayerFeePct)}%`;
    leaf.relayData.payoutAdjustmentPct = `${formatFeePct(leaf.payoutAdjustmentPct)}%`;
    delete leaf.relayData.destinationToken;
    delete leaf.relayData.realizedLpFeePct;
    delete leaf.relayData.relayerFeePct;
    delete leaf.payoutAdjustmentPct;
    delete leaf.relayData.originChainId;
    delete leaf.relayData.destinationChainId;
    slowRelayLeavesPretty += `\n\t\t\t${index}: ${JSON.stringify(leaf.relayData)}`;
  });

  const slowRelayMsg = slowRelayLeavesPretty
    ? `root:${shortenHexString(slowRelayRoot)}...\n\t\tleaves:${slowRelayLeavesPretty}`
    : "No slow relay leaves";
  return (
    `\n\t*Bundle blocks*:${bundleBlockRangePretty}` +
    `\n\t*PoolRebalance*:\n\t\troot:${shortenHexString(
      poolRebalanceRoot
    )}...\n\t\tleaves:${poolRebalanceLeavesPretty}` +
    `\n\t*RelayerRefund*\n\t\troot:${shortenHexString(relayerRefundRoot)}...\n\t\tleaves:${relayerRefundLeavesPretty}` +
    `\n\t*SlowRelay*\n\t${slowRelayMsg}`
  );
}

export function prettyPrintLeaves(
  logger: winston.Logger,
  tree: MerkleTree<PoolRebalanceLeaf> | MerkleTree<RelayerRefundLeaf> | MerkleTree<SlowFillLeaf>,
  leaves: PoolRebalanceLeaf[] | RelayerRefundLeaf[] | SlowFillLeaf[],
  logType = "Pool rebalance"
): void {
  leaves.forEach((leaf, index) => {
    const prettyLeaf = Object.keys(leaf).reduce((result, key) => {
      // Check if leaf value is list of BN's or single BN.
      if (Array.isArray(leaf[key]) && BigNumber.isBigNumber(leaf[key][0])) {
        result[key] = leaf[key].map((val) => val.toString());
      } else if (BigNumber.isBigNumber(leaf[key])) {
        result[key] = leaf[key].toString();
      } else {
        result[key] = leaf[key];
      }
      return result;
    }, {});
    logger.debug({
      at: "Dataworker#propose",
      message: `${logType} leaf #${index}`,
      leaf: prettyLeaf,
      proof: tree.getHexProof(leaf),
    });
  });
}

import { AcrossConfigStoreClient, HubPoolClient, SpokePoolClient } from "../clients";
import * as interfaces from "../interfaces";
import {
  BigNumberForToken,
  PoolRebalanceLeaf,
  RelayData,
  RelayerRefundLeaf,
  PendingRootBundle,
  RunningBalances,
  UnfilledDeposit,
} from "../interfaces";
import {
  assign,
  BigNumber,
  compareAddresses,
  convertFromWei,
  shortenHexString,
  shortenHexStrings,
  toBN,
  MerkleTree,
  winston,
  toBNWei,
  formatFeePct,
} from "../utils";
import { DataworkerClients } from "./DataworkerClientHelper";
import { getFillDataForSlowFillFromPreviousRootBundle } from "../utils";

export function updateRunningBalance(
  runningBalances: interfaces.RunningBalances,
  l2ChainId: number,
  l1Token: string,
  updateAmount: BigNumber
) {
  // Initialize dictionary if empty.
  if (!runningBalances[l2ChainId]) runningBalances[l2ChainId] = {};
  const runningBalance = runningBalances[l2ChainId][l1Token];
  if (runningBalance) runningBalances[l2ChainId][l1Token] = runningBalance.add(updateAmount);
  else runningBalances[l2ChainId][l1Token] = updateAmount;
}

export function updateRunningBalanceForFill(
  endBlockForMainnet: number,
  runningBalances: interfaces.RunningBalances,
  hubPoolClient: HubPoolClient,
  fill: interfaces.FillWithBlock,
  updateAmount: BigNumber
) {
  const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
    fill.destinationChainId.toString(),
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
) {
  const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
    deposit.originChainId.toString(),
    deposit.originToken,
    deposit.blockNumber
  );
  updateRunningBalance(runningBalances, deposit.originChainId, l1TokenCounterpart, updateAmount);
}

export function addLastRunningBalance(
  latestMainnetBlock: number,
  runningBalances: interfaces.RunningBalances,
  hubPoolClient: HubPoolClient
) {
  Object.keys(runningBalances).forEach((repaymentChainId) => {
    Object.keys(runningBalances[repaymentChainId]).forEach((l1TokenAddress) => {
      const lastRunningBalance = hubPoolClient.getRunningBalanceBeforeBlockForChain(
        latestMainnetBlock,
        Number(repaymentChainId),
        l1TokenAddress
      );
      if (!lastRunningBalance.eq(toBN(0)))
        updateRunningBalance(runningBalances, Number(repaymentChainId), l1TokenAddress, lastRunningBalance);
    });
  });
}

export function initializeRunningBalancesFromRelayerRepayments(
  runningBalances: RunningBalances,
  realizedLpFees: RunningBalances,
  latestMainnetBlock: number,
  hubPoolClient: HubPoolClient,
  fillsToRefund: interfaces.FillsToRefund
) {
  if (Object.keys(fillsToRefund).length > 0) {
    Object.keys(fillsToRefund).forEach((repaymentChainId: string) => {
      Object.keys(fillsToRefund[repaymentChainId]).forEach((l2TokenAddress: string) => {
        const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
          repaymentChainId,
          l2TokenAddress,
          latestMainnetBlock
        );

        // Realized LP fees is only affected by relayer repayments so we'll return a brand new dictionary of those
        // mapped to each { repaymentChainId, repaymentToken } combination.
        assign(
          realizedLpFees,
          [repaymentChainId, l1TokenCounterpart],
          fillsToRefund[repaymentChainId][l2TokenAddress].realizedLpFees
        );

        // Add total repayment amount to running balances. Note: totalRefundAmount won't exist for chains that
        // only had slow fills, so we should explicitly check for it.
        if (fillsToRefund[repaymentChainId][l2TokenAddress].totalRefundAmount)
          assign(
            runningBalances,
            [repaymentChainId, l1TokenCounterpart],
            fillsToRefund[repaymentChainId][l2TokenAddress].totalRefundAmount
          );
        else assign(runningBalances, [repaymentChainId, l1TokenCounterpart], toBN(0));
      });
    });
  }
}

export function addSlowFillsToRunningBalances(
  latestMainnetBlock: number,
  runningBalances: interfaces.RunningBalances,
  hubPoolClient: HubPoolClient,
  unfilledDeposits: UnfilledDeposit[]
) {
  unfilledDeposits.forEach((unfilledDeposit) => {
    const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
      unfilledDeposit.deposit.originChainId.toString(),
      unfilledDeposit.deposit.originToken,
      latestMainnetBlock
    );
    updateRunningBalance(
      runningBalances,
      unfilledDeposit.deposit.destinationChainId,
      l1TokenCounterpart,
      unfilledDeposit.unfilledAmount
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

export function subtractExcessFromPreviousSlowFillsFromRunningBalances(
  mainnetBundleEndBlock: number,
  runningBalances: interfaces.RunningBalances,
  hubPoolClient: HubPoolClient,
  allValidFills: interfaces.FillWithBlock[],
  allValidFillsInRange: interfaces.FillWithBlock[],
  chainIdListForBundleEvaluationBlockNumbers: number[]
) {
  const excesses = {};
  // We need to subtract excess from any fills that might replaced a slow fill sent to the fill destination chain.
  // This can only happen if the fill was the last fill for a deposit. Otherwise, its still possible that the slow fill
  // for the deposit can be executed, so we'll defer the excess calculation until the hypothetical slow fill executes.
  // In addition to fills that are not the last fill for a deposit, we can ignore fills that completely fill a deposit
  // as the first fill. These fills could never have triggered a deposit since there were no partial fills for it.
  // This assumption depends on the rule that slow fills can only be sent after a partial fill for a non zero amount
  // of the deposit. This is why "1 wei" fills are important, otherwise we'd never know which fills originally
  // triggered a slow fill payment to be sent to the destination chain.
  allValidFillsInRange
    .filter((fill) => fill.totalFilledAmount.eq(fill.amount) && !fill.fillAmount.eq(fill.amount))
    .forEach((fill: interfaces.FillWithBlock) => {
      const { lastFillBeforeSlowFillIncludedInRoot, rootBundleEndBlockContainingFirstFill } =
        getFillDataForSlowFillFromPreviousRootBundle(
          hubPoolClient.latestBlockNumber,
          fill,
          allValidFills,
          hubPoolClient,
          chainIdListForBundleEvaluationBlockNumbers
        );

      // Now that we have the last fill sent in a previous root bundle that also sent a slow fill, we can compute
      // the excess that we need to decrease running balances by. This excess only exists in the case where the
      // current fill completed a deposit. There will be an excess if (1) the slow fill was never executed, and (2)
      // the slow fill was executed, but not before some partial fills were sent.

      // Note, if there is NO fill from a previous root bundle for the same deposit as this fill, then there has been
      // no slow fill payment sent to the spoke pool yet, so we can exit early.
      if (lastFillBeforeSlowFillIncludedInRoot === undefined) return;

      // If first fill for this deposit is in this epoch, then no slow fill has been sent so we can ignore this fill.
      // We can check this by searching for a ProposeRootBundle event with a bundle block range that contains the
      // first fill for this deposit. If it is the same as the ProposeRootBundle event containing the
      // current fill, then the first fill is in the current bundle and we can exit early.
      const rootBundleEndBlockContainingFullFill = hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(
        hubPoolClient.latestBlockNumber,
        fill.blockNumber,
        fill.destinationChainId,
        chainIdListForBundleEvaluationBlockNumbers
      );
      if (rootBundleEndBlockContainingFirstFill === rootBundleEndBlockContainingFullFill) return;

      // Recompute how much the matched root bundle sent for this slow fill.
      const amountSentForSlowFill = lastFillBeforeSlowFillIncludedInRoot.amount.sub(
        lastFillBeforeSlowFillIncludedInRoot.totalFilledAmount
      );

      // If this fill is a slow fill, then the excess remaining in the contract is equal to the amount sent originally
      // for this slow fill, and the amount filled. If this fill was not a slow fill, then that means the slow fill
      // was never sent, so we need to send the full slow fill back.
      const excess = fill.isSlowRelay ? amountSentForSlowFill.sub(fill.fillAmount) : amountSentForSlowFill;
      if (excess.eq(toBN(0))) return;

      // Log excesses for debugging since this logic is so complex.
      if (excesses[fill.destinationChainId] === undefined) excesses[fill.destinationChainId] = {};
      if (excesses[fill.destinationChainId][fill.destinationToken] === undefined)
        excesses[fill.destinationChainId][fill.destinationToken] = [];
      excesses[fill.destinationChainId][fill.destinationToken].push({
        excess: excess.toString(),
        lastFillBeforeSlowFillIncludedInRoot,
        rootBundleEndBlockContainingFirstFill,
        rootBundleEndBlockContainingFullFill: rootBundleEndBlockContainingFullFill
          ? rootBundleEndBlockContainingFullFill
          : "N/A",
        finalFill: fill,
      });

      updateRunningBalanceForFill(mainnetBundleEndBlock, runningBalances, hubPoolClient, fill, excess.mul(toBN(-1)));
    });

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
  configStoreClient: AcrossConfigStoreClient,
  maxL1TokenCount?: number,
  tokenTransferThreshold?: BigNumberForToken
) {
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

        // Build leaves using running balances and realized lp fees data for l1Token + chain, or default to
        // zero if undefined.
        const leafBundleLpFees = l1TokensToIncludeInThisLeaf.map((l1Token) => {
          if (realizedLpFees[chainId]?.[l1Token]) return realizedLpFees[chainId][l1Token];
          else return toBN(0);
        });
        const leafNetSendAmounts = l1TokensToIncludeInThisLeaf.map((l1Token, index) => {
          if (runningBalances[chainId] && runningBalances[chainId][l1Token])
            return getNetSendAmountForL1Token(transferThresholds[index], runningBalances[chainId][l1Token]);
          else return toBN(0);
        });
        const leafRunningBalances = l1TokensToIncludeInThisLeaf.map((l1Token, index) => {
          if (runningBalances[chainId]?.[l1Token])
            return getRunningBalanceForL1Token(transferThresholds[index], runningBalances[chainId][l1Token]);
          else return toBN(0);
        });

        leaves.push({
          chainId: Number(chainId),
          bundleLpFees: leafBundleLpFees,
          netSendAmounts: leafNetSendAmounts,
          runningBalances: leafRunningBalances,
          groupIndex: groupIndexForChainId++,
          leafId: leaves.length,
          l1Tokens: l1TokensToIncludeInThisLeaf,
        });
      }
    });
  return leaves;
}

// If the running balance is greater than the token transfer threshold, then set the net send amount
// equal to the running balance and reset the running balance to 0. Otherwise, the net send amount should be
// 0, indicating that we do not want the data worker to trigger a token transfer between hub pool and spoke
// pool when executing this leaf.
export function getNetSendAmountForL1Token(transferThreshold: BigNumber, runningBalance: BigNumber): BigNumber {
  return runningBalance.abs().gte(transferThreshold) ? runningBalance : toBN(0);
}

export function getRunningBalanceForL1Token(transferThreshold: BigNumber, runningBalance: BigNumber): BigNumber {
  return runningBalance.abs().lt(transferThreshold) ? runningBalance : toBN(0);
}

// This returns a possible next block range that could be submitted as a new root bundle, or used as a reference
// when evaluating  pending root bundle. The block end numbers must be less than the latest blocks for each chain ID
// (because we can't evaluate events in the future), and greater than the the expected start blocks, which are the
// greater of 0 and the latest bundle end block for an executed root bundle proposal + 1.
export async function getWidestPossibleExpectedBlockRange(
  chainIdListForBundleEvaluationBlockNumbers: number[],
  spokeClients: { [chainId: number]: SpokePoolClient },
  endBlockBuffers: number[],
  clients: DataworkerClients,
  latestMainnetBlock: number
): Promise<number[][]> {
  const latestBlockNumbers = chainIdListForBundleEvaluationBlockNumbers.map((chainId: number, index) =>
    Math.max(spokeClients[chainId].latestBlockNumber - endBlockBuffers[index], 0)
  );
  // We subtract a buffer from the end blocks to reduce the chance that network providers
  // for different bot runs produce different contract state because of variability near the HEAD of the network.
  // Reducing the latest block that we query also gives partially filled deposits slightly more buffer for relayers
  // to fully fill the deposit and reduces the chance that the data worker includes a slow fill payment that gets
  // filled during the challenge period.
  return chainIdListForBundleEvaluationBlockNumbers.map((chainId: number, index) => [
    clients.hubPoolClient.getNextBundleStartBlockNumber(
      chainIdListForBundleEvaluationBlockNumbers,
      latestMainnetBlock,
      chainId
    ),
    latestBlockNumbers[index],
  ]);
}

export function generateMarkdownForDisputeInvalidBundleBlocks(
  chainIdListForBundleEvaluationBlockNumbers: number[],
  pendingRootBundle: PendingRootBundle,
  widestExpectedBlockRange: number[][],
  buffers: number[]
) {
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

export function generateMarkdownForDispute(pendingRootBundle: PendingRootBundle) {
  return (
    "Disputed pending root bundle:" +
    `\n\tPoolRebalance leaf count: ${pendingRootBundle.unclaimedPoolRebalanceLeafCount}` +
    `\n\tPoolRebalance root: ${shortenHexString(pendingRootBundle.poolRebalanceRoot)}` +
    `\n\tRelayerRefund root: ${shortenHexString(pendingRootBundle.relayerRefundRoot)}` +
    `\n\tSlowRelay root: ${shortenHexString(pendingRootBundle.slowRelayRoot)}` +
    `\n\tProposer: ${shortenHexString(pendingRootBundle.proposer)}`
  );
}

export function generateMarkdownForRootBundle(
  hubPoolClient: HubPoolClient,
  chainIdListForBundleEvaluationBlockNumbers: number[],
  hubPoolChainId: number,
  bundleBlockRange: number[][],
  poolRebalanceLeaves: any[],
  poolRebalanceRoot: string,
  relayerRefundLeaves: any[],
  relayerRefundRoot: string,
  slowRelayLeaves: any[],
  slowRelayRoot: string
): string {
  // Create helpful logs to send to slack transport
  let bundleBlockRangePretty = "";
  chainIdListForBundleEvaluationBlockNumbers.forEach((chainId, index) => {
    bundleBlockRangePretty += `\n\t\t${chainId}: ${JSON.stringify(bundleBlockRange[index])}`;
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
    const decimalsForDestToken = hubPoolClient.getTokenInfo(leaf.destinationChainId, leaf.destinationToken).decimals;
    // Shorten keys for ease of reading from Slack.
    delete leaf.leafId;
    leaf.originChain = leaf.originChainId;
    leaf.destinationChain = leaf.destinationChainId;
    leaf.depositor = shortenHexString(leaf.depositor);
    leaf.recipient = shortenHexString(leaf.recipient);
    leaf.destToken = convertTokenAddressToSymbol(leaf.destinationChainId, leaf.destinationToken);
    leaf.amount = convertFromWei(leaf.amount, decimalsForDestToken);
    // Fee decimals is always 18. 1e18 = 100% so 1e16 = 1%.
    leaf.realizedLpFee = `${formatFeePct(leaf.realizedLpFeePct)}%`;
    leaf.relayerFee = `${formatFeePct(leaf.relayerFeePct)}%`;
    delete leaf.destinationToken;
    delete leaf.realizedLpFeePct;
    delete leaf.relayerFeePct;
    delete leaf.originChainId;
    delete leaf.destinationChainId;
    slowRelayLeavesPretty += `\n\t\t\t${index}: ${JSON.stringify(leaf)}`;
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
  tree: MerkleTree<PoolRebalanceLeaf> | MerkleTree<RelayerRefundLeaf> | MerkleTree<RelayData>,
  leaves: PoolRebalanceLeaf[] | RelayerRefundLeaf[] | RelayData[],
  logType = "Pool rebalance"
) {
  leaves.forEach((leaf, index) => {
    const prettyLeaf = Object.keys(leaf).reduce((result, key) => {
      // Check if leaf value is list of BN's or single BN.
      if (Array.isArray(leaf[key]) && BigNumber.isBigNumber(leaf[key][0]))
        result[key] = leaf[key].map((val) => val.toString());
      else if (BigNumber.isBigNumber(leaf[key])) result[key] = leaf[key].toString();
      else result[key] = leaf[key];
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

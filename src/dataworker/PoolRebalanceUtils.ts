import assert from "assert";
import { typechain, utils as sdkUtils } from "@across-protocol/sdk-v2";
import { ConfigStoreClient, HubPoolClient, SpokePoolClient } from "../clients";
import { Clients } from "../common";
import * as interfaces from "../interfaces";
import {
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
  bnZero,
  BigNumber,
  fixedPointAdjustment as fixedPoint,
  MerkleTree,
  assign,
  compareAddresses,
  convertFromWei,
  formatFeePct,
  getFillDataForSlowFillFromPreviousRootBundle,
  getNetworkName,
  getRefund,
  shortenHexString,
  shortenHexStrings,
  spreadEventWithBlockNumber,
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
  const l1TokenCounterpart = hubPoolClient.getL1TokenForL2TokenAtBlock(
    sdkUtils.getFillOutputToken(fill),
    fill.destinationChainId,
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
  const l1TokenCounterpart = hubPoolClient.getL1TokenForL2TokenAtBlock(
    sdkUtils.getDepositInputToken(deposit),
    deposit.originChainId,
    deposit.quoteBlockNumber
  );
  updateRunningBalance(runningBalances, deposit.originChainId, l1TokenCounterpart, updateAmount);
}

export function updateRunningBalanceForEarlyDeposit(
  runningBalances: interfaces.RunningBalances,
  hubPoolClient: HubPoolClient,
  depositEvent: typechain.FundsDepositedEvent,
  updateAmount: BigNumber
): void {
  const deposit = { ...spreadEventWithBlockNumber(depositEvent) } as interfaces.DepositWithBlock;
  const { originChainId } = deposit;

  const l1TokenCounterpart = hubPoolClient.getL1TokenForL2TokenAtBlock(
    sdkUtils.getDepositInputToken(deposit),
    originChainId,
    // TODO: this must be handled s.t. it doesn't depend on when this is run.
    // For now, tokens do not change their mappings often, so this will work, but
    // to keep the system resilient, this must be updated.
    hubPoolClient.latestBlockSearched
  );

  updateRunningBalance(runningBalances, originChainId, l1TokenCounterpart, updateAmount);
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
      if (!runningBalance.eq(bnZero)) {
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
        const l1TokenCounterpart = hubPoolClient.getL1TokenForL2TokenAtBlock(
          l2TokenAddress,
          repaymentChainId,
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
          assign(runningBalances, [repaymentChainId, l1TokenCounterpart], bnZero);
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
  unfilledDeposits.forEach(({ deposit, unfilledAmount }) => {
    const l1TokenCounterpart = hubPoolClient.getL1TokenForL2TokenAtBlock(
      sdkUtils.getDepositInputToken(deposit),
      deposit.originChainId,
      latestMainnetBlock
    );
    updateRunningBalance(
      runningBalances,
      deposit.destinationChainId,
      l1TokenCounterpart,
      getRefund(unfilledAmount, deposit.realizedLpFeePct)
    );
  });
}

// TODO: Is summing up absolute values really the best way to compute a root bundle's "volume"? Said another way,
// how do we measure a root bundle's "impact" or importance?
export async function computePoolRebalanceUsdVolume(
  leaves: PoolRebalanceLeaf[],
  clients: DataworkerClients
): Promise<BigNumber> {
  // Fetch the set of unique token addresses from the array of PoolRebalanceLeave objects.
  // Map the resulting HubPool token addresses to symbol, decimals, and price.
  const hubPoolTokens = Object.fromEntries(
    Array.from(new Set(leaves.map(({ l1Tokens }) => l1Tokens).flat()))
      .map((address) => clients.hubPoolClient.getTokenInfoForL1Token(address))
      .map(({ symbol, decimals, address }) => [address, { symbol, decimals, price: bnZero }])
  );

  // Fetch all relevant token prices.
  const prices = await clients.priceClient.getPricesByAddress(
    Object.keys(hubPoolTokens).map((address) => address),
    "usd"
  );

  // Scale token price to 18 decimals.
  prices.forEach(({ address, price }) => (hubPoolTokens[address].price = toBNWei(price)));

  const bn10 = toBN(10);
  return leaves.reduce((result: BigNumber, poolRebalanceLeaf) => {
    return poolRebalanceLeaf.l1Tokens.reduce((sum: BigNumber, l1Token: string, index: number) => {
      const { decimals, price: usdTokenPrice } = hubPoolTokens[l1Token];

      const netSendAmount = poolRebalanceLeaf.netSendAmounts[index];
      const volume = netSendAmount.abs().mul(bn10.pow(18 - decimals)); // Scale volume to 18 decimals.

      const usdVolume = volume.mul(usdTokenPrice).div(fixedPoint);
      return sum.add(usdVolume);
    }, result);
  }, bnZero);
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
      .filter((fill) => {
        // @todo This filter implicitly produces an array of v2 fills because it is impossible for v3 fills to pass.
        // Update the filter such that it also passes v3 fills where a slow fill was initially produced.
        const outputAmount = sdkUtils.getFillOutputAmount(fill);
        const fillAmount = sdkUtils.getFillAmount(fill);
        const totalFilledAmount = sdkUtils.getTotalFilledAmount(fill);
        return totalFilledAmount.eq(outputAmount) && !fillAmount.eq(outputAmount);
      })
      .map(async (fill: interfaces.FillWithBlock) => {
        assert(sdkUtils.isV2Fill(fill)); // @todo Remove when the above filter permits v3 fills to pass.

        const { lastMatchingFillInSameBundle, rootBundleEndBlockContainingFirstFill } =
          await getFillDataForSlowFillFromPreviousRootBundle(
            hubPoolClient.latestBlockSearched,
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
          hubPoolClient.latestBlockSearched,
          fill.blockNumber,
          fill.destinationChainId
        );
        if (rootBundleEndBlockContainingFirstFill === rootBundleEndBlockContainingFullFill) {
          return;
        }

        // Recompute how much the matched root bundle sent for this slow fill.
        const outputAmount = sdkUtils.getFillOutputAmount(lastMatchingFillInSameBundle);
        const totalFilledAmount = sdkUtils.getTotalFilledAmount(lastMatchingFillInSameBundle);
        const preFeeAmountSentForSlowFill = outputAmount.sub(totalFilledAmount);

        // If this fill is a slow fill, then the excess remaining in the contract is equal to the amount sent originally
        // for this slow fill, and the amount filled. If this fill was not a slow fill, then that means the slow fill
        // was never sent, so we need to send the full slow fill back.
        const excess = getRefund(
          sdkUtils.isSlowFill(fill)
            ? preFeeAmountSentForSlowFill.sub(sdkUtils.getFillAmount(fill))
            : preFeeAmountSentForSlowFill,
          fill.realizedLpFeePct
        );
        if (excess.eq(bnZero)) {
          return;
        }

        // Log excesses for debugging since this logic is so complex.
        const outputToken = sdkUtils.getFillOutputToken(fill);
        excesses[fill.destinationChainId] ??= {};
        excesses[fill.destinationChainId][outputToken] ??= [];
        excesses[fill.destinationChainId][outputToken].push({
          excess: excess.toString(),
          lastMatchingFillInSameBundle,
          rootBundleEndBlockContainingFirstFill,
          rootBundleEndBlockContainingFullFill: rootBundleEndBlockContainingFullFill
            ? rootBundleEndBlockContainingFullFill
            : "N/A",
          finalFill: fill,
        });

        updateRunningBalanceForFill(mainnetBundleEndBlock, runningBalances, hubPoolClient, fill, excess.mul(-1));
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
  maxL1TokenCount?: number
): interfaces.PoolRebalanceLeaf[] {
  // Create one leaf per L2 chain ID. First we'll create a leaf with all L1 tokens for each chain ID, and then
  // we'll split up any leaves with too many L1 tokens.
  const leaves: interfaces.PoolRebalanceLeaf[] = [];
  Object.keys(runningBalances)
    .map((chainId) => Number(chainId))
    // Leaves should be sorted by ascending chain ID
    .sort((chainIdA, chainIdB) => chainIdA - chainIdB)
    .map((chainId) => {
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

        const spokeTargetBalances = l1TokensToIncludeInThisLeaf.map((l1Token) =>
          configStoreClient.getSpokeTargetBalancesForBlock(l1Token, chainId, latestMainnetBlock)
        );

        // Build leaves using running balances and realized lp fees data for l1Token + chain, or default to
        // zero if undefined.
        const leafBundleLpFees = l1TokensToIncludeInThisLeaf.map(
          (l1Token) => realizedLpFees[chainId]?.[l1Token] ?? bnZero
        );
        const leafNetSendAmounts = l1TokensToIncludeInThisLeaf.map((l1Token, index) =>
          runningBalances[chainId] && runningBalances[chainId][l1Token]
            ? getNetSendAmountForL1Token(spokeTargetBalances[index], runningBalances[chainId][l1Token])
            : bnZero
        );
        const leafRunningBalances = l1TokensToIncludeInThisLeaf.map((l1Token, index) =>
          runningBalances[chainId]?.[l1Token]
            ? getRunningBalanceForL1Token(spokeTargetBalances[index], runningBalances[chainId][l1Token])
            : bnZero
        );

        leaves.push({
          chainId: chainId,
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
    return bnZero;
  }

  // We are left with the case where the spoke pool is beyond the threshold.
  // A transfer needs to be initiated to bring it down to the target.
  const transferSize = runningBalance.abs().sub(spokePoolTargetBalance.target);

  // If the transferSize is < 0, this indicates that the target is still above the running balance.
  // This can only happen if the threshold is less than the target. This is likely due to a misconfiguration.
  // In this case, we transfer nothing until the target is exceeded.
  if (transferSize.lt(0)) {
    return bnZero;
  }

  // Negate the transfer size because a transfer from spoke to hub is indicated by a negative number.
  return transferSize.mul(-1);
}

// If the running balance is greater than the token transfer threshold, then set the net send amount
// equal to the running balance and reset the running balance to 0. Otherwise, the net send amount should be
// 0, indicating that we do not want the data worker to trigger a token transfer between hub pool and spoke
// pool when executing this leaf.
export function getNetSendAmountForL1Token(
  spokePoolTargetBalance: SpokePoolTargetBalance,
  runningBalance: BigNumber
): BigNumber {
  return computeDesiredTransferAmountToSpoke(runningBalance, spokePoolTargetBalance);
}

export function getRunningBalanceForL1Token(
  spokePoolTargetBalance: SpokePoolTargetBalance,
  runningBalance: BigNumber
): BigNumber {
  const desiredTransferAmount = computeDesiredTransferAmountToSpoke(runningBalance, spokePoolTargetBalance);
  return runningBalance.sub(desiredTransferAmount);
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
      spokeClients[chainId] && Math.max(spokeClients[chainId].latestBlockSearched - endBlockBuffers[index], 0)
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
  slowRelayLeaves: SlowFillLeaf[],
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
    const outputToken = sdkUtils.getRelayDataOutputToken(leaf.relayData);
    const destinationChainId = sdkUtils.getSlowFillLeafChainId(leaf);
    const outputTokenDecimals = hubPoolClient.getTokenInfo(destinationChainId, outputToken).decimals;

    // @todo: When v2 types are removed, update the slowFill definition to be more precise about the memebr fields.
    const slowFill: Record<string, number | string> = {
      // Shorten select keys for ease of reading from Slack.
      depositor: shortenHexString(leaf.relayData.depositor),
      recipient: shortenHexString(leaf.relayData.recipient),
      originChainId: leaf.relayData.originChainId,
      destinationChainId: destinationChainId,
      depositId: leaf.relayData.depositId,
      message: leaf.relayData.message,
    };

    if (sdkUtils.isV2SlowFillLeaf(leaf)) {
      slowFill.destinationToken = convertTokenAddressToSymbol(leaf.relayData.destinationChainId, outputToken);
      slowFill.amount = convertFromWei(leaf.relayData.amount.toString(), outputTokenDecimals);
      // Fee decimals is always 18. 1e18 = 100% so 1e16 = 1%.
      slowFill.realizedLpFeePct = `${formatFeePct(leaf.relayData.realizedLpFeePct)}%`;
      slowFill.payoutAdjustmentPct = `${formatFeePct(toBN(leaf.payoutAdjustmentPct))}%`;
    } else {
      // Scale amounts to 18 decimals for realizedLpFeePct computation.
      const scaleBy = toBN(10).pow(18 - outputTokenDecimals);
      const inputAmount = leaf.relayData.inputAmount.mul(scaleBy);
      const updatedOutputAmount = leaf.updatedOutputAmount.mul(scaleBy);
      assert(
        inputAmount.gte(updatedOutputAmount),
        "Unexpected output amount for slow fill on" +
          ` ${getNetworkName(leaf.relayData.originChainId)} depositId ${leaf.relayData.depositId}`
      );

      // Infer the realizedLpFeePct from the spread between inputAmount and updatedOutputAmount (sans relayer fee).
      const realizedLpFeePct = inputAmount.sub(updatedOutputAmount).mul(fixedPoint).div(inputAmount);

      slowFill.outputToken = outputToken;
      slowFill.outputAmount = convertFromWei(updatedOutputAmount.toString(), 18); // tokens were scaled to 18 decimals.
      slowFill.realizedLpFeePct = `${formatFeePct(realizedLpFeePct)}%`;
    }

    slowRelayLeavesPretty += `\n\t\t\t${index}: ${JSON.stringify(slowFill)}`;
  });

  const slowRelayMsg = slowRelayLeavesPretty
    ? `root:${shortenHexString(slowRelayRoot)}...\n\t\tleaves:${slowRelayLeavesPretty}`
    : "No slow relay leaves";
  return (
    "\n" +
    `\t*Bundle blocks*:${bundleBlockRangePretty}\n` +
    "\t*PoolRebalance*:\n" +
    `\t\troot:${shortenHexString(poolRebalanceRoot)}...\n` +
    `\t\tleaves:${poolRebalanceLeavesPretty}\n` +
    "\t*RelayerRefund*\n" +
    `\t\troot:${shortenHexString(relayerRefundRoot)}...\n` +
    `\t\tleaves:${relayerRefundLeavesPretty}\n` +
    "\t*SlowRelay*\n" +
    `\t${slowRelayMsg}`
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

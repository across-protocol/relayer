import { AcrossConfigStoreClient, HubPoolClient } from "../clients";
import * as interfaces from "../interfaces";
import { BigNumberForToken } from "../interfaces";
import { assign, BigNumber, compareAddresses, toBN } from "../utils";
import { getFillDataForSlowFillFromPreviousRootBundle } from "./FillUtils";

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
  runningBalances: interfaces.RunningBalances,
  hubPoolClient: HubPoolClient,
  fill: interfaces.FillWithBlock,
  updateAmount: BigNumber
) {
  const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
    fill.destinationChainId.toString(),
    fill.destinationToken,
    fill.blockNumber
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

export function initializeRunningBalancesFromRelayerRepayments(
  latestMainnetBlock: number,
  hubPoolClient: HubPoolClient,
  fillsToRefund: interfaces.FillsToRefund
) {
  const runningBalances = {};
  const realizedLpFees: interfaces.RunningBalances = {};

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

        // Start with running balance value from last valid root bundle proposal for {chainId, l1Token}
        // combination if found.
        const startingRunningBalance = hubPoolClient.getRunningBalanceBeforeBlockForChain(
          latestMainnetBlock,
          Number(repaymentChainId),
          l1TokenCounterpart
        );

        // Add total repayment amount to running balances. Note: totalRefundAmount won't exist for chains that
        // only had slow fills, so we should explicitly check for it.
        if (fillsToRefund[repaymentChainId][l2TokenAddress].totalRefundAmount)
          assign(
            runningBalances,
            [repaymentChainId, l1TokenCounterpart],
            startingRunningBalance.add(fillsToRefund[repaymentChainId][l2TokenAddress].totalRefundAmount)
          );
      });
    });
  }
  return {
    runningBalances,
    realizedLpFees,
  };
}

export function subtractExcessFromPreviousSlowFillsFromRunningBalances(
  runningBalances: interfaces.RunningBalances,
  hubPoolClient: HubPoolClient,
  allValidFills: interfaces.FillWithBlock[],
  chainIdListForBundleEvaluationBlockNumbers: number[]
) {
  allValidFills.forEach((fill: interfaces.FillWithBlock) => {
    const { lastFillBeforeSlowFillIncludedInRoot, rootBundleEndBlockContainingFirstFill } =
      getFillDataForSlowFillFromPreviousRootBundle(
        fill,
        allValidFills,
        hubPoolClient,
        chainIdListForBundleEvaluationBlockNumbers
      );

    // Now that we have the last fill sent in a previous root bundle that also sent a slow fill, we can compute
    // the excess that we need to decrease running balances by. This excess only exists in two cases:
    // 1) The current fill is a slow fill. In this case, we need to check if there were any partial fills sent
    //    AFTER the slow fill amount was sent to the spoke pool, and BEFORE the slow fill was executed.
    // 2) The current fill completed a deposit, meaning that the slow fill never had a chance to be executed. We should
    //    send back the full slow fill amount sent in a previous root bundle.

    // Note, if there is NO fill from a previous root bundle for the same deposit as this fill, then there has been
    // no slow fill payment sent to the spoke pool yet, so we can exit early.

    // For any executed slow fills, we need to decrease the running balance if a previous root bundle sent
    // tokens to the spoke pool to pay for the slow fill, but a partial fill was sent before the slow relay
    // could be executed, resulting in an excess of funds on the spoke pool.
    if (fill.isSlowRelay) {
      // Since every slow fill should have a partial fill that came before it, we should always be able to find the
      // last partial fill for the root bundle including the slow fill refund.
      if (!lastFillBeforeSlowFillIncludedInRoot)
        throw new Error("Can't find last fill submitted before slow fill was included in root bundle proposal");

      // Recompute how much the matched root bundle sent for this slow fill. Subtract the amount that was
      // actually executed on the L2 from the amount that was sent. This should give us the excess that was sent.
      // Subtract that amount from the running balance so we ultimately send it back to L1.
      const amountSentForSlowFill = lastFillBeforeSlowFillIncludedInRoot.amount.sub(
        lastFillBeforeSlowFillIncludedInRoot.totalFilledAmount
      );
      const excess = amountSentForSlowFill.sub(fill.fillAmount);
      if (excess.eq(toBN(0))) return; // Exit early if slow fill left no excess funds.
      updateRunningBalanceForFill(runningBalances, hubPoolClient, fill, excess.mul(toBN(-1)));
    }
    // For all fills that completely filled a relay and that followed a partial fill from a previous epoch, we need
    // to decrease running balances by the slow fill amount sent in the previous epoch, since the slow relay was never
    // executed, allowing the fill to be sent completely filling the deposit.
    else if (fill.totalFilledAmount.eq(fill.amount)) {
      // If first fill for this deposit is in this epoch, then no slow fill has been sent so we can ignore this fill.
      // We can check this by searching for a ProposeRootBundle event with a bundle block range that contains the
      // first fill for this deposit. If it is the same as the ProposeRootBundle event containing the
      // current fill, then the first fill is in the current bundle and we can exit early.
      const rootBundleEndBlockContainingFullFill = hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(
        fill.blockNumber,
        fill.destinationChainId,
        chainIdListForBundleEvaluationBlockNumbers
      );
      if (rootBundleEndBlockContainingFirstFill === rootBundleEndBlockContainingFullFill) return;

      // If full fill and first fill are in different blocks, then we should always be able to find the last partial
      // fill included in the root bundle that also included the slow fill refund.
      if (!lastFillBeforeSlowFillIncludedInRoot)
        throw new Error("Can't find last fill submitted before slow fill was included in root bundle proposal");

      // Recompute how much the matched root bundle sent for this slow fill. This slow fill refund needs to be sent
      // back to the hub because it was completely replaced by partial fills submitted after the root bundle
      // proposal. We know that there was no slow fill execution because the `fullFill` completely filled the deposit,
      // meaning that no slow fill was executed before it, and no slow fill can be executed after it.
      const amountSentForSlowFill = lastFillBeforeSlowFillIncludedInRoot.amount.sub(
        lastFillBeforeSlowFillIncludedInRoot.totalFilledAmount
      );
      updateRunningBalanceForFill(runningBalances, hubPoolClient, fill, amountSentForSlowFill.mul(toBN(-1)));
    }
  });
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

        leaves.push({
          chainId: Number(chainId),
          bundleLpFees: realizedLpFees[chainId]
            ? l1TokensToIncludeInThisLeaf.map((l1Token) => realizedLpFees[chainId][l1Token])
            : Array(l1TokensToIncludeInThisLeaf.length).fill(toBN(0)),
          netSendAmounts: runningBalances[chainId]
            ? l1TokensToIncludeInThisLeaf.map((l1Token, index) =>
                getNetSendAmountForL1Token(transferThresholds[index], runningBalances[chainId][l1Token])
              )
            : Array(l1TokensToIncludeInThisLeaf.length).fill(toBN(0)),
          runningBalances: runningBalances[chainId]
            ? l1TokensToIncludeInThisLeaf.map((l1Token, index) =>
                getRunningBalanceForL1Token(transferThresholds[index], runningBalances[chainId][l1Token])
              )
            : Array(l1TokensToIncludeInThisLeaf.length).fill(toBN(0)),
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

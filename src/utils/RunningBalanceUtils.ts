import { utils as sdkUtils } from "@across-protocol/sdk";
import { BigNumber, isDefined, toBN, EvmAddress } from ".";
import { ProposedRootBundle } from "../interfaces";
import { BundleDataApproxClient } from "../clients/BundleDataApproxClient";
import { HubPoolClient } from "../clients";

type RunningBalanceResult = {
  absLatestRunningBalance: BigNumber;
  lastValidatedRunningBalance: BigNumber;
  upcomingDeposits: BigNumber;
  upcomingRefunds: BigNumber;
  bundleEndBlock: number;
  proposedRootBundle: string | undefined;
};

/**
 * Returns running balances for an l1Token on the specified chains.
 * @param l1Token L1 token address to query.
 * @param chainsToEvaluate Chain IDs to compute running balances for.
 * @param hubPoolClient HubPoolClient instance for querying validated bundles.
 * @param bundleDataApproxClient BundleDataApproxClient for upcoming deposits/refunds.
 * @returns Dictionary keyed by chain ID of running balance results.
 */
export async function getLatestRunningBalances(
  l1Token: EvmAddress,
  chainsToEvaluate: number[],
  hubPoolClient: HubPoolClient,
  bundleDataApproxClient: BundleDataApproxClient
): Promise<{ [chainId: number]: RunningBalanceResult }> {
  const chainIds = hubPoolClient.configStoreClient.getChainIdIndicesForBlock();

  const entries = await sdkUtils.mapAsync(chainsToEvaluate, async (chainId) => {
    const chainIdIndex = chainIds.indexOf(chainId);

    // We need to find the latest validated running balance for this chain and token.
    const lastValidatedRunningBalance = hubPoolClient.getRunningBalanceBeforeBlockForChain(
      hubPoolClient.latestHeightSearched,
      chainId,
      l1Token
    ).runningBalance;

    // Approximate latest running balance for a chain as last known validated running balance...
    // - minus total deposit amount on chain since the latest validated end block
    // - plus total refund amount on chain since the latest validated end block
    const latestValidatedBundle = hubPoolClient.getLatestExecutedRootBundleContainingL1Token(
      hubPoolClient.latestHeightSearched,
      chainId,
      l1Token
    );
    const l2Token = hubPoolClient.getL2TokenForL1TokenAtBlock(l1Token, Number(chainId));
    if (!isDefined(l2Token)) {
      return undefined;
    }

    // If there is no ExecutedRootBundle event in the hub pool client's lookback for the token and chain, then
    // default the bundle end block to 0. This will force getUpcomingDepositAmount to count any deposit
    // seen in the spoke pool client's lookback. It would be very odd however for there to be deposits or refunds
    // for a token and chain without there being a validated root bundle containing the token, so really the
    // following check will be hit if the chain's running balance is very stale. The best way to check
    // its running balance at that point is to query the token balance directly but this is still potentially
    // inaccurate if someone sent tokens directly to the contract, and it incurs an extra RPC call so we avoid
    // it for now. The default running balance will be 0, and this function is primarily designed to choose
    // which chains have too many running balances and therefore should be selected for repayment, so returning
    // 0 here means this chain will never be selected for repayment as a "slow withdrawal" chain.
    let lastValidatedBundleEndBlock = 0;
    let proposedRootBundle: ProposedRootBundle | undefined;
    if (latestValidatedBundle) {
      // The ProposeRootBundle event must precede the ExecutedRootBundle event we grabbed above. However, it
      // might not exist if the ExecutedRootBundle event is old enough that the preceding ProposeRootBundle is
      // older than the lookback. In this case, leave the last validated bundle end block as 0, since it must be
      // before the earliest lookback block.
      proposedRootBundle = hubPoolClient.getLatestFullyExecutedRootBundle(latestValidatedBundle.blockNumber);
      if (proposedRootBundle) {
        lastValidatedBundleEndBlock = proposedRootBundle.bundleEvaluationBlockNumbers[chainIdIndex].toNumber();
      }
    }

    const upcomingDeposits = bundleDataApproxClient.getUpcomingDeposits(chainId, l1Token);
    const upcomingRefunds = bundleDataApproxClient.getUpcomingRefunds(chainId, l1Token);

    // Updated running balance is last known running balance minus deposits plus upcoming refunds.
    const latestRunningBalance = lastValidatedRunningBalance.sub(upcomingDeposits).add(upcomingRefunds);
    // A negative running balance means that the spoke has a balance. If the running balance is positive, then the
    // hub owes it funds and its below target so we don't want to take additional repayment.
    const absLatestRunningBalance = latestRunningBalance.lt(0) ? latestRunningBalance.abs() : toBN(0);

    return [
      chainId,
      {
        absLatestRunningBalance,
        lastValidatedRunningBalance,
        upcomingDeposits,
        upcomingRefunds,
        bundleEndBlock: lastValidatedBundleEndBlock,
        proposedRootBundle: proposedRootBundle?.txnRef,
      },
    ];
  });

  return Object.fromEntries(entries.filter(isDefined));
}

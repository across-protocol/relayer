/**
 * This client is used to get approximate bundle data using spoke and hub pool client data, without needing to
 * go through the relatively longer process of constructing full bundle data from scratch, like the BundleDataClient.
 */

import { SpokePoolManager } from ".";
import { SpokePoolClientsByChain } from "../interfaces";
import {
  assert,
  BigNumber,
  isDefined,
  winston,
  ConvertDecimals,
  getTokenInfo,
  getInventoryEquivalentL1TokenAddress,
  getInventoryBalanceContributorTokens,
} from "../utils";
import { Address, bnZero } from "../utils/SDKUtils";
import { HubPoolClient } from "./HubPoolClient";

export type BundleDataState = {
  upcomingDeposits: { [l1Token: string]: { [chainId: number]: BigNumber } };
  upcomingRefunds: { [l1Token: string]: { [chainId: number]: { [relayer: string]: BigNumber } } };
};

// Internally, refunds are additionally keyed by the L2 token the refund leaf will pay out in.
// The exported/serialized BundleDataState keeps the flat per-relayer sums for cross-version stability.
type RefundsByChain = { [chainId: number]: { [relayer: string]: { [repaymentToken: string]: BigNumber } } };

// Imported (deserialized) state carries no per-repayment-token breakdown, so its chain-level sums are
// keyed under this sentinel. Chain-level queries — the only consumers of imported state — are unaffected.
const UNKNOWN_REPAYMENT_TOKEN = "unknown";

// This client is used to approximate running balances and the refunds and deposits for a given L1 token. Running balances
// can easily be estimated by taking the last validated running balance for a chain and subtracting the total deposit amount
// on that chain since the last validated end block and adding the total refund amount on that chain since the last validated
// end block.
export class BundleDataApproxClient {
  private upcomingRefunds: { [l1Token: string]: RefundsByChain } | undefined = undefined;
  private upcomingDeposits: { [l1Token: string]: { [chainId: number]: BigNumber } } | undefined = undefined;
  private readonly spokePoolManager: SpokePoolManager;

  private readonly protocolChainIdIndices: number[];
  constructor(
    spokePoolClients: SpokePoolClientsByChain,
    private readonly hubPoolClient: HubPoolClient,
    private readonly chainIdList: number[],
    private readonly l1Tokens: Address[],
    private readonly logger: winston.Logger
  ) {
    this.spokePoolManager = new SpokePoolManager(logger, spokePoolClients);
    this.protocolChainIdIndices = this.hubPoolClient.configStoreClient.getChainIdIndicesForBlock();
  }

  /**
   * Export current BundleData(Approx)Client state.
   * @returns BundleData(Approx)Client state. This can be subsequently ingested by BundleDataApproxClient.import().
   */
  export(): BundleDataState {
    const { upcomingDeposits, upcomingRefunds } = this;
    assert(
      isDefined(upcomingDeposits) && isDefined(upcomingRefunds),
      "BundleDataApproxClient#export: client not initialized"
    );
    // Flatten the per-repayment-token breakdown so the serialized shape is stable across versions.
    const flattenedRefunds = Object.fromEntries(
      Object.entries(upcomingRefunds).map(([l1Token, byChain]) => [
        l1Token,
        Object.fromEntries(
          Object.entries(byChain).map(([chainId, byRelayer]) => [
            chainId,
            Object.fromEntries(
              Object.entries(byRelayer).map(([relayer, byToken]) => [
                relayer,
                Object.values(byToken).reduce((acc, amount) => acc.add(amount), bnZero),
              ])
            ),
          ])
        ),
      ])
    );
    return { upcomingDeposits, upcomingRefunds: flattenedRefunds };
  }

  /**
   * Import BundleData(Approx)Client state.
   * @params state BundleData(Approx)Client state, previously exported.
   * @returns void
   */
  import(state: BundleDataState): void {
    const { upcomingDeposits, upcomingRefunds } = state;
    this.upcomingDeposits = upcomingDeposits;
    this.upcomingRefunds = Object.fromEntries(
      Object.entries(upcomingRefunds).map(([l1Token, byChain]) => [
        l1Token,
        Object.fromEntries(
          Object.entries(byChain).map(([chainId, byRelayer]) => [
            chainId,
            Object.fromEntries(
              Object.entries(byRelayer).map(([relayer, amount]) => [relayer, { [UNKNOWN_REPAYMENT_TOKEN]: amount }])
            ),
          ])
        ),
      ])
    );
  }

  /**
   * Return sum of refunds for all fills sent after the fromBlocks.
   * Makes a simple assumption that all fills that were sent by this relayer after the last executed bundle
   * are valid and will be refunded on the repayment chain selected.
   * @param l1Token L1 token to get refunds for all inventory-equivalent L2 tokens on each chain.
   * @param fromBlocks 2D block mapping indexed by [referenceChainId][fillChainId]. For refund counting, each fill
   * is filtered using fromBlocks[repaymentChainId][fillChainId] so that a fill is only excluded when the
   * repayment chain's refund leaf has been executed — not when the fill chain's own refund leaf was executed.
   * This prevents under-counting refunds when cross-chain relay propagation is delayed.
   * @returns Refunds grouped by relayer and repayment token for each chain. Refunds are denominated in
   * L1 token decimals, but keyed by the L2 token that the refund leaf will pay out in.
   */
  protected getApproximateRefundsForToken(
    l1Token: Address,
    fromBlocks: { [chainId: number]: { [chainId: number]: number } }
  ): RefundsByChain {
    const refundsForChain: RefundsByChain = {};
    for (const chainId of this.chainIdList) {
      refundsForChain[chainId] ??= {};
      const spokePoolClient = this.spokePoolManager.getClient(chainId);
      if (!isDefined(spokePoolClient)) {
        continue;
      }
      spokePoolClient.getFills().forEach((fill) => {
        const { inputAmount: _refundAmount, originChainId, repaymentChainId, relayer, inputToken, blockNumber } = fill;
        // Filter based on the repayment chain's execution state: a fill on chain X with repayment on
        // chain Y should only be excluded when chain Y's refund leaf has been executed.
        if (blockNumber < (fromBlocks[repaymentChainId]?.[chainId] ?? 0)) {
          return;
        }

        // Fills get refunded in the input token currency so need to check that the input token
        // and the l1Token parameter are the same. If the input token is equivalent from an inventory management
        // perspective to the l1Token then we can count it here because in this case the refund for the fill
        // will essentially be in an equivalent l1Token currency on the repayment chain (i.e. getting repaid
        // in this currency is just as good as getting repaid in the l1Token currency).
        const expectedL1Token = this.getL1TokenAddress(fill.inputToken, fill.originChainId);
        if (!isDefined(expectedL1Token) || !expectedL1Token.eq(l1Token)) {
          return;
        }

        // Origin-chain repayments pay out in the deposit's input token; all other repayments pay out in the
        // pool-rebalance-route token on the repayment chain (see getRefundInformationFromFill in the SDK).
        // Track refunds by that payout token so callers can attribute them to the exact token repaid.
        const repaymentToken =
          repaymentChainId === originChainId ? inputToken : this.getRepaymentTokenForChain(l1Token, repaymentChainId);
        if (!isDefined(repaymentToken)) {
          // No pool rebalance route to the repayment chain: the dataworker cannot repay there either.
          return;
        }

        const { decimals: inputTokenDecimals } = getTokenInfo(inputToken, originChainId);
        const refundAmount = ConvertDecimals(
          inputTokenDecimals,
          getTokenInfo(l1Token, this.hubPoolClient.chainId).decimals
        )(_refundAmount);
        refundsForChain[repaymentChainId] ??= {};
        const relayerRefunds = (refundsForChain[repaymentChainId][relayer.toNative()] ??= {});
        const repaymentTokenKey = repaymentToken.toNative();
        relayerRefunds[repaymentTokenKey] = (relayerRefunds[repaymentTokenKey] ?? bnZero).add(refundAmount);
      });
    }
    return refundsForChain;
  }

  /**
   * Return the L2 token that refund leaves pay out in on the given chain, i.e. the l1Token's pool
   * rebalance route token. Mirrors the dataworker's repayment token resolution for cross-chain repayments.
   */
  protected getRepaymentTokenForChain(l1Token: Address, repaymentChainId: number): Address | undefined {
    assert(l1Token.isEVM());
    return this.hubPoolClient.getL2TokenForL1TokenAtBlock(l1Token, repaymentChainId);
  }

  // For each chain, find the last executed (or relayed) bundle and return a 2D mapping of start blocks:
  // result[chainId][c] = the start block on chain c derived from the last executed bundle on chainId.
  // This 2D structure is needed because a bundle executed on chain A may not yet be relayed to chain B
  // (due to cross-chain propagation delays), so the correct start block for counting fills depends on
  // which chain's execution state is being used as the reference. For refunds, the reference chain is
  // the repayment chain; for deposits, it is the deposit's own chain (the diagonal: result[chainId][chainId]).
  protected getUnexecutedBundleStartBlocks(
    l1Token: Address,
    requireExecution: boolean
  ): { [chainId: number]: { [chainId: number]: number } } {
    assert(l1Token.isEVM());
    return Object.fromEntries(
      this.chainIdList.map((chainId) => {
        const spokePoolClient = this.spokePoolManager.getClient(chainId);
        assert(isDefined(spokePoolClient), `SpokePoolClient not found for chainId ${chainId}`);
        // Step 1: Find the last RelayedRootBundle event that was relayed to this chain. Assume this contains refunds
        // from the last executed bundle for this chain and these refunds were executed.
        const lastRelayedRootToChain = spokePoolClient.getRootBundleRelays().findLast((relay) => {
          if (!isDefined(relay)) {
            return false;
          }

          // If we don't require execution verification, return the last relayed root bundle directly.
          // This is used for deposit counting where the boundary is bundle validation/relay, not leaf execution.
          if (!requireExecution) {
            return true;
          }

          const l2Tokens = getInventoryBalanceContributorTokens(l1Token, chainId, this.hubPoolClient.chainId);
          return isDefined(
            spokePoolClient.getRelayerRefundExecutions().findLast((execution) => {
              if (!isDefined(execution)) {
                return false;
              }
              // Its possible that there are multiple refund leaves for the same chain + L1 token combo in the same
              // root bundle. In that case, we're going to return true if at least one leaf was executed. In all
              // likelihood, all leaves were executed in the same transaction. If they were not, then this client
              // will underestimate the upcoming refunds until that leaf is executed. Since this client is ultimately
              // an approximation, this is acceptable.
              return (
                execution.rootBundleId === relay.rootBundleId &&
                l2Tokens.some((l2Token) => l2Token.eq(execution.l2TokenAddress))
              );
            })
          );
        });
        if (!isDefined(lastRelayedRootToChain)) {
          return [chainId, Object.fromEntries(this.chainIdList.map((c) => [c, 0]))];
        }

        // Step 2: Match the last RelayedRootBundle event to a proposed root bundle. If there is no corresponding root
        // bundle then its likely that the proposed root bundle was very old, possibly because this chain hasn't had
        // refund root relayed to it in a while, so for the purposes of this function, we'll assume that there are
        // no refunds for this chain.
        const correspondingProposedRootBundle = this.hubPoolClient
          .getValidatedRootBundles()
          .find((bundle) => bundle.relayerRefundRoot === lastRelayedRootToChain.relayerRefundRoot);
        if (!isDefined(correspondingProposedRootBundle)) {
          return [chainId, Object.fromEntries(this.chainIdList.map((c) => [c, Number.MAX_SAFE_INTEGER]))];
        }

        // Step 3. Find the next bundle start blocks following the proposed root bundle for all chains.
        // This returns the bundle's end blocks for every chain, not just this chain, so that callers
        // can look up the correct boundary for cross-chain refund scenarios.
        return [
          chainId,
          Object.fromEntries(
            this.chainIdList.map((c) => {
              const bundleEndBlock = this.hubPoolClient.getBundleEndBlockForChain(
                correspondingProposedRootBundle,
                c,
                this.protocolChainIdIndices
              );
              return [c, bundleEndBlock > 0 ? bundleEndBlock + 1 : 0];
            })
          ),
        ];
      })
    );
  }

  private getApproximateUpcomingRefunds(l1Token: Address): ReturnType<typeof this.getApproximateRefundsForToken> {
    const fromBlocks = this.getUnexecutedBundleStartBlocks(l1Token, true);
    const refundsForChain = this.getApproximateRefundsForToken(l1Token, fromBlocks);
    return refundsForChain;
  }

  /**
   * Return sum of deposits for all deposits sent after the fromBlocks.
   * @param l1Token L1 token to get deposits for all inventory-equivalent L2 tokens on each chain.
   * @param fromBlocks 2D block mapping indexed by [referenceChainId][depositChainId]. For deposit counting,
   * only the diagonal is used: fromBlocks[chainId][chainId], since deposits are counted per origin chain.
   * @returns Deposits grouped by chain. Deposits are denominated in L1 token decimals.
   */
  private getApproximateDepositsForToken(
    l1Token: Address,
    fromBlocks: { [chainId: number]: { [chainId: number]: number } }
  ): { [chainId: number]: BigNumber } {
    const depositsForChain: { [chainId: number]: BigNumber } = {};
    for (const chainId of this.chainIdList) {
      depositsForChain[chainId] ??= bnZero;
      const spokePoolClient = this.spokePoolManager.getClient(chainId);
      if (!isDefined(spokePoolClient)) {
        continue;
      }
      spokePoolClient
        .getDeposits()
        .filter((deposit) => {
          if (deposit.blockNumber < (fromBlocks[chainId]?.[chainId] ?? 0)) {
            return false;
          }
          // We are ok to group together deposits for inventory-equivalent tokens because these approximate
          // deposits and refunds are usually computed and summed together to approximate running balances. So we should
          // use the same methodology for equating input and l1 tokens as we do in the getApproximateRefundsForToken method.
          const expectedL1Token = this.getL1TokenAddress(deposit.inputToken, deposit.originChainId);
          if (!isDefined(expectedL1Token)) {
            return false;
          }
          return l1Token.eq(expectedL1Token);
        })
        .forEach((deposit) => {
          const depositAmount = ConvertDecimals(
            getTokenInfo(deposit.inputToken, deposit.originChainId).decimals,
            getTokenInfo(l1Token, this.hubPoolClient.chainId).decimals
          )(deposit.inputAmount);
          depositsForChain[chainId] = depositsForChain[chainId].add(depositAmount);
        });
    }
    return depositsForChain;
  }

  private getApproximateUpcomingDepositsForToken(
    l1Token: Address
  ): ReturnType<typeof this.getApproximateDepositsForToken> {
    // Deposits don't need to be executed following a root bundle validation so we pass in `false` for `requireExecution`.
    const fromBlocks = this.getUnexecutedBundleStartBlocks(l1Token, false);
    const depositsForChain = this.getApproximateDepositsForToken(l1Token, fromBlocks);
    return depositsForChain;
  }

  protected getL1TokenAddress(l2Token: Address, chainId: number): Address | undefined {
    try {
      return getInventoryEquivalentL1TokenAddress(l2Token, chainId, this.hubPoolClient.chainId);
    } catch {
      return undefined;
    }
  }

  initialize(): void {
    this.upcomingRefunds = {};
    this.upcomingDeposits = {};
    for (const l1Token of this.l1Tokens) {
      this.upcomingRefunds[l1Token.toNative()] = this.getApproximateUpcomingRefunds(l1Token);
      this.upcomingDeposits[l1Token.toNative()] = this.getApproximateUpcomingDepositsForToken(l1Token);
    }
    this.logger.debug({
      at: "BundleDataApproxClient#initialize",
      message: "Initialized BundleDataApproxClient",
      l1Tokens: this.l1Tokens.map((l1Token) => l1Token.toNative()),
      upcomingRefunds: this.upcomingRefunds,
      upcomingDeposits: this.upcomingDeposits,
    });
  }

  /**
   * Return refunds for a given L1 token on a given chain for all inventory-equivalent L2 tokens on that chain.
   * Refunds are denominated in L1 token decimals.
   * @param chainId Chain ID to get refunds for.
   * @param l1Token L1 token to get refunds for.
   * @param relayer Optional relayer to get refunds for. If not provided, returns the sum of refunds for all relayers.
   * @param repaymentToken Optional L2 token the refund leaf will pay out in. If provided, returns only refunds paid
   * in that token. The breakdown is not available on imported state, which only carries chain-level sums.
   * @returns Refunds for the given L1 token on the given chain for all inventory-equivalent L2 tokens on that chain. Refunds are denominated in L1 token decimals.
   */
  getUpcomingRefunds(chainId: number, l1Token: Address, relayer?: Address, repaymentToken?: Address): BigNumber {
    assert(
      isDefined(this.upcomingRefunds),
      "BundleDataApproxClient#getUpcomingRefunds: Upcoming refunds not initialized"
    );
    const refundsByRelayer = this.upcomingRefunds[l1Token.toNative()]?.[chainId] ?? {};
    const relayerRefunds = isDefined(relayer)
      ? [refundsByRelayer[relayer.toNative()] ?? {}]
      : Object.values(refundsByRelayer);
    return relayerRefunds
      .flatMap((byToken) =>
        isDefined(repaymentToken) ? [byToken[repaymentToken.toNative()] ?? bnZero] : Object.values(byToken)
      )
      .reduce((acc, amount) => acc.add(amount), bnZero);
  }

  /**
   * Return deposits for a given L1 token on a given chain for all inventory-equivalent L2 tokens on that chain.
   * Deposits are denominated in L1 token decimals.
   * @param chainId Chain ID to get deposits for.
   * @param l1Token L1 token to get deposits for.
   * @returns Deposits for the given L1 token on the given chain for all inventory-equivalent L2 tokens on that chain. Deposits are denominated in L1 token decimals.
   */
  getUpcomingDeposits(chainId: number, l1Token: Address): BigNumber {
    assert(
      isDefined(this.upcomingDeposits),
      "BundleDataApproxClient#getUpcomingDeposits: Upcoming deposits not initialized"
    );
    if (!this.upcomingDeposits[l1Token.toNative()]) {
      return bnZero;
    }
    return this.upcomingDeposits[l1Token.toNative()][chainId] ?? bnZero;
  }
}

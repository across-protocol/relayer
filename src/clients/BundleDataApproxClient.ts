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

// This client is used to approximate running balances and the refunds and deposits for a given L1 token. Running balances
// can easily be estimated by taking the last validated running balance for a chain and subtracting the total deposit amount
// on that chain since the last validated end block and adding the total refund amount on that chain since the last validated
// end block.
export class BundleDataApproxClient {
  private upcomingRefunds: { [l1Token: string]: { [chainId: number]: { [relayer: string]: BigNumber } } } = undefined;
  private upcomingDeposits: { [l1Token: string]: { [chainId: number]: BigNumber } } = undefined;
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
    return { upcomingDeposits, upcomingRefunds };
  }

  /**
   * Import BundleData(Approx)Client state.
   * @params state BundleData(Approx)Client state, previously exported.
   * @returns void
   */
  import(state: BundleDataState): void {
    const { upcomingDeposits, upcomingRefunds } = state;
    this.upcomingDeposits = upcomingDeposits;
    this.upcomingRefunds = upcomingRefunds;
  }

  /**
   * Return sum of refunds for all fills sent after the fromBlocks.
   * Makes a simple assumption that all fills that were sent by this relayer after the last executed bundle
   * are valid and will be refunded on the repayment chain selected.
   * @param l1Token L1 token to get refunds for all inventory-equivalent L2 tokens on each chain.
   * @param fromBlocks Blocks to start counting refunds from.
   * @returns Refunds grouped by relayer for each chain. Refunds are denominated in L1 token decimals.
   */
  protected getApproximateRefundsForToken(
    l1Token: Address,
    fromBlocks: { [chainId: number]: number }
  ): { [repaymentChainId: number]: { [relayer: string]: BigNumber } } {
    const refundsForChain: { [repaymentChainId: number]: { [relayer: string]: BigNumber } } = {};
    for (const chainId of this.chainIdList) {
      refundsForChain[chainId] ??= {};
      const spokePoolClient = this.spokePoolManager.getClient(chainId);
      if (!isDefined(spokePoolClient)) {
        continue;
      }
      spokePoolClient.getFills().forEach((fill) => {
        const { inputAmount: _refundAmount, originChainId, repaymentChainId, relayer, inputToken, blockNumber } = fill;
        if (blockNumber < fromBlocks[chainId]) {
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

        const { decimals: inputTokenDecimals } = getTokenInfo(inputToken, originChainId);
        const refundAmount = ConvertDecimals(
          inputTokenDecimals,
          getTokenInfo(l1Token, this.hubPoolClient.chainId).decimals
        )(_refundAmount);
        refundsForChain[repaymentChainId] ??= {};
        refundsForChain[repaymentChainId][relayer.toNative()] ??= bnZero;
        refundsForChain[repaymentChainId][relayer.toNative()] =
          refundsForChain[repaymentChainId][relayer.toNative()].add(refundAmount);
      });
    }
    return refundsForChain;
  }

  // Return the next starting block for each chain following the bundle end block of the last executed bundle that
  // was relayed to that chain.
  protected getUnexecutedBundleStartBlocks(l1Token: Address): { [chainId: number]: number } {
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
          return [chainId, 0];
        }

        // Step 2: Match the last RelayedRootBundle event to a proposed root bundle. If there is no corresponding root
        // bundle then its likely that the proposed root bundle was very old, possibly because this chain hasn't had
        // refund root relayed to it in a while, so for the purposes of this function, we'll assume that there are
        // no refunds for this chain.
        const correspondingProposedRootBundle = this.hubPoolClient
          .getValidatedRootBundles()
          .find((bundle) => bundle.relayerRefundRoot === lastRelayedRootToChain.relayerRefundRoot);
        if (!isDefined(correspondingProposedRootBundle)) {
          return [chainId, Number.MAX_SAFE_INTEGER];
        }

        // Step 3. Find the next bundle start blocks following the proposed root bundle.
        const bundleEndBlock = this.hubPoolClient.getBundleEndBlockForChain(
          correspondingProposedRootBundle,
          chainId,
          this.protocolChainIdIndices
        );
        return [chainId, bundleEndBlock > 0 ? bundleEndBlock + 1 : 0];
      })
    );
  }

  private getApproximateUpcomingRefunds(l1Token: Address): ReturnType<typeof this.getApproximateRefundsForToken> {
    const fromBlocks = this.getUnexecutedBundleStartBlocks(l1Token);
    const refundsForChain = this.getApproximateRefundsForToken(l1Token, fromBlocks);
    return refundsForChain;
  }

  /**
   * Return sum of deposits for all deposits sent after the fromBlocks.
   * @param l1Token L1 token to get deposits for all inventory-equivalent L2 tokens on each chain.
   * @param fromBlocks Blocks to start counting deposits from.
   * @returns Deposits grouped by chain. Deposits are denominated in L1 token decimals.
   */
  private getApproximateDepositsForToken(
    l1Token: Address,
    fromBlocks: { [chainId: number]: number }
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
          // We are ok to group together deposits for inventory-equivalent tokens because these approximate
          // deposits and refunds are usually computed and summed together to approximate running balances. So we should
          // use the same methodology for equating input and l1 tokens as we do in the getApproximateRefundsForToken method.
          const expectedL1Token = this.getL1TokenAddress(deposit.inputToken, deposit.originChainId);
          if (!isDefined(expectedL1Token)) {
            return false;
          }
          return l1Token.eq(expectedL1Token) && deposit.blockNumber >= fromBlocks[chainId];
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
    const fromBlocks = this.getUnexecutedBundleStartBlocks(l1Token);
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
   * @returns Refunds for the given L1 token on the given chain for all inventory-equivalent L2 tokens on that chain. Refunds are denominated in L1 token decimals.
   */
  getUpcomingRefunds(chainId: number, l1Token: Address, relayer?: Address): BigNumber {
    assert(
      isDefined(this.upcomingRefunds),
      "BundleDataApproxClient#getUpcomingRefunds: Upcoming refunds not initialized"
    );
    assert(
      this.upcomingRefunds[l1Token.toNative()],
      `BundleDataApproxClient#getUpcomingRefunds: L1 token ${l1Token.toNative()} not found`
    );
    if (isDefined(relayer)) {
      return this.upcomingRefunds[l1Token.toNative()][chainId]?.[relayer.toNative()] ?? bnZero;
    }
    return Object.values(this.upcomingRefunds[l1Token.toNative()][chainId] ?? {}).reduce(
      (acc, curr) => acc.add(curr),
      bnZero
    );
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
    assert(this.upcomingDeposits[l1Token.toNative()], "BundleDataApproxClient#getUpcomingDeposits: L1 token not found");
    return this.upcomingDeposits[l1Token.toNative()][chainId] ?? bnZero;
  }
}

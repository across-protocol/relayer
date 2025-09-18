/**
 * This client is used to get approximate bundle data using spoke and hub pool client data, without needing to
 * go through the relatively longer process of constructing full bundle data from scratch, like the BundleDataClient.
 */

import { SpokePoolManager } from ".";
import { SpokePoolClientsByChain } from "../interfaces";
import { assert, BigNumber, isDefined, winston } from "../utils";
import { Address, bnZero, getL1TokenAddress } from "../utils/SDKUtils";
import { HubPoolClient } from "./HubPoolClient";

export class BundleDataApproxClient {
  private upcomingRefunds: { [l1Token: string]: { [chainId: number]: { [relayer: string]: BigNumber } } } = undefined;
  private upcomingDeposits: { [l1Token: string]: { [chainId: number]: BigNumber } } = undefined;
  private readonly spokePoolManager: SpokePoolManager;

  constructor(
    spokePoolClients: SpokePoolClientsByChain,
    private readonly hubPoolClient: HubPoolClient,
    private readonly chainIdList: number[],
    private readonly l1Tokens: Address[],
    private readonly logger: winston.Logger
  ) {
    this.spokePoolManager = new SpokePoolManager(logger, spokePoolClients);
  }

  // Return sum of refunds for all fills sent after the fromBlocks.
  // Makes a simple assumption that all fills that were sent after the last executed bundle
  // are valid and will be refunded on the repayment chain selected. Assume additionally that the repayment chain
  // set is a valid one for the deposit.
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
      spokePoolClient
        .getFills()
        .filter((fill) => {
          if (fill.blockNumber < fromBlocks[chainId]) {
            return false;
          }
          const expectedL1Token = this.getL1TokenAddress(fill.inputToken, fill.originChainId);
          if (!isDefined(expectedL1Token) || !expectedL1Token.eq(l1Token)) {
            return false;
          }
          // A simple check that this fill is *probably* valid is to check that the output and input token
          // map to the same L1 token. This means that this method will ignore refunds for swaps, but these
          // are currently very rare in practice. This prevents invalid fills with very large input amounts
          // from skewing the numbers.
          const outputMappedL1Token = this.getL1TokenAddress(fill.outputToken, fill.destinationChainId);
          if (!isDefined(outputMappedL1Token) || !outputMappedL1Token.eq(expectedL1Token)) {
            return false;
          }

          return true;
        })
        .forEach((fill) => {
          const { inputAmount: refundAmount, repaymentChainId, relayer } = fill;
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
  protected getUnexecutedBundleStartBlocks(): { [chainId: number]: number } {
    return Object.fromEntries(
      this.chainIdList.map((chainId) => {
        const spokePoolClient = this.spokePoolManager.getClient(chainId);
        assert(isDefined(spokePoolClient), `SpokePoolClient not found for chainId ${chainId}`);
        // Step 1: Find the last RelayedRootBundle event that was relayed to this chain. Assume this contains refunds
        // from the last executed bundle for this chain and these refunds were executed.
        const lastRelayedRootToChain = spokePoolClient.getRootBundleRelays().at(-1);
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
          this.chainIdList
        );
        return [chainId, bundleEndBlock > 0 ? bundleEndBlock + 1 : 0];
      })
    );
  }

  private getApproximateUpcomingRefunds(l1Token: Address): ReturnType<typeof this.getApproximateRefundsForToken> {
    const fromBlocks = this.getUnexecutedBundleStartBlocks();
    const refundsForChain = this.getApproximateRefundsForToken(l1Token, fromBlocks);
    return refundsForChain;
  }

  private getApproximateDepositsForToken(
    l1Token: Address,
    fromBlocks: { [chainId: number]: number }
  ): { [chainId: number]: BigNumber } {
    const depositsForChain: { [chainId: number]: BigNumber } = {};
    for (const chainId of this.chainIdList) {
      const spokePoolClient = this.spokePoolManager.getClient(chainId);
      depositsForChain[chainId] ??= bnZero;
      if (!isDefined(spokePoolClient)) {
        continue;
      }
      spokePoolClient
        .getDeposits()
        .filter((deposit) => {
          const expectedL1Token = this.getL1TokenAddress(deposit.inputToken, deposit.originChainId);
          if (!isDefined(expectedL1Token)) {
            return false;
          }
          return l1Token.eq(expectedL1Token) && deposit.blockNumber >= fromBlocks[chainId];
        })
        .forEach((deposit) => {
          depositsForChain[chainId] = depositsForChain[chainId].add(deposit.inputAmount);
        });
    }
    return depositsForChain;
  }

  private getApproximateUpcomingDepositsForToken(
    l1Token: Address
  ): ReturnType<typeof this.getApproximateDepositsForToken> {
    const fromBlocks = this.getUnexecutedBundleStartBlocks();
    const depositsForChain = this.getApproximateDepositsForToken(l1Token, fromBlocks);
    return depositsForChain;
  }

  protected getL1TokenAddress(l2Token: Address, chainId: number): Address | undefined {
    try {
      return getL1TokenAddress(l2Token, chainId);
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
      upcomingRefunds: this.upcomingRefunds,
      upcomingDeposits: this.upcomingDeposits,
    });
  }

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

  getUpcomingDeposits(chainId: number, l1Token: Address): BigNumber {
    assert(
      isDefined(this.upcomingDeposits),
      "BundleDataApproxClient#getUpcomingDeposits: Upcoming deposits not initialized"
    );
    assert(this.upcomingDeposits[l1Token.toNative()], "BundleDataApproxClient#getUpcomingDeposits: L1 token not found");
    return this.upcomingDeposits[l1Token.toNative()][chainId] ?? bnZero;
  }
}

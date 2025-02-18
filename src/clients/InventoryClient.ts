import { constants, utils as sdkUtils } from "@across-protocol/sdk";
import WETH_ABI from "../common/abi/Weth.json";
import {
  bnZero,
  BigNumber,
  winston,
  toBN,
  getNetworkName,
  createFormatFunction,
  blockExplorerLink,
  Contract,
  formatUnits,
  runTransaction,
  isDefined,
  DefaultLogLevels,
  TransactionResponse,
  AnyObject,
  ERC20,
  TOKEN_SYMBOLS_MAP,
  formatFeePct,
  fixedPointAdjustment,
  bnComparatorDescending,
  MAX_UINT_VAL,
  toBNWei,
  assert,
  compareAddressesSimple,
  getUsdcSymbol,
  Profiler,
  getNativeTokenSymbol,
} from "../utils";
import { HubPoolClient, TokenClient, BundleDataClient } from ".";
import { Deposit, ProposedRootBundle } from "../interfaces";
import { InventoryConfig, isAliasConfig, TokenBalanceConfig } from "../interfaces/InventoryManagement";
import lodash from "lodash";
import { SLOW_WITHDRAWAL_CHAINS } from "../common";
import { CombinedRefunds } from "../dataworker/DataworkerUtils";
import { AdapterManager, CrossChainTransferClient } from "./bridges";

type TokenDistribution = { [l2Token: string]: BigNumber };
type TokenDistributionPerL1Token = { [l1Token: string]: { [chainId: number]: TokenDistribution } };

export type Rebalance = {
  chainId: number;
  l1Token: string;
  l2Token: string;
  thresholdPct: BigNumber;
  targetPct: BigNumber;
  currentAllocPct: BigNumber;
  balance: BigNumber;
  cumulativeBalance: BigNumber;
  amount: BigNumber;
};

const { CHAIN_IDs } = constants;
const DEFAULT_TOKEN_OVERAGE = toBNWei("1.5");

export class InventoryClient {
  private logDisabledManagement = false;
  private readonly scalar: BigNumber;
  private readonly formatWei: ReturnType<typeof createFormatFunction>;
  private bundleRefundsPromise: Promise<CombinedRefunds[]> = undefined;
  private excessRunningBalancePromises: { [l1Token: string]: Promise<{ [chainId: number]: BigNumber }> } = {};
  private profiler: InstanceType<typeof Profiler>;

  constructor(
    readonly relayer: string,
    readonly logger: winston.Logger,
    readonly inventoryConfig: InventoryConfig,
    readonly tokenClient: TokenClient,
    readonly chainIdList: number[],
    readonly hubPoolClient: HubPoolClient,
    readonly bundleDataClient: BundleDataClient,
    readonly adapterManager: AdapterManager,
    readonly crossChainTransferClient: CrossChainTransferClient,
    readonly simMode = false,
    readonly prioritizeLpUtilization = true
  ) {
    this.scalar = sdkUtils.fixedPointAdjustment;
    this.formatWei = createFormatFunction(2, 4, false, 18);
    this.profiler = new Profiler({
      logger: this.logger,
      at: "InventoryClient",
    });
  }

  /**
   * Resolve the token balance configuration for `l1Token` on `chainId`. If `l1Token` maps to multiple tokens on
   * `chainId` then `l2Token` must be supplied.
   * @param l1Token L1 token address to query.
   * @param chainId Chain ID to query on
   * @param l2Token Optional L2 token address when l1Token maps to multiple l2Token addresses.
   */
  getTokenConfig(l1Token: string, chainId: number, l2Token?: string): TokenBalanceConfig | undefined {
    const tokenConfig = this.inventoryConfig.tokenConfig[l1Token];
    if (!isDefined(tokenConfig)) {
      return;
    }

    if (isAliasConfig(tokenConfig)) {
      assert(isDefined(l2Token), `Cannot resolve ambiguous ${getNetworkName(chainId)} token config for ${l1Token}`);
      return tokenConfig[l2Token]?.[chainId];
    } else {
      return tokenConfig[chainId];
    }
  }

  /*
   * Get the total balance for an L1 token across all chains, considering any outstanding cross chain transfers as a
   * virtual balance on that chain.
   * @param l1Token L1 token address to query.
   * returns Cumulative balance of l1Token across all inventory-managed chains.
   */
  getCumulativeBalance(l1Token: string): BigNumber {
    return this.getEnabledChains()
      .map((chainId) => this.getBalanceOnChain(chainId, l1Token))
      .reduce((acc, curr) => acc.add(curr), bnZero);
  }

  /**
   * Determine the effective/virtual balance of an l1 token that has been deployed to another chain.
   * Includes both the actual balance on the chain and any pending inbound transfers to the target chain.
   * If l2Token is supplied, return its balance on the specified chain. Otherwise, return the total allocation
   * of l1Token on the specified chain.
   * @param chainId Chain to query token balance on.
   * @param l1Token L1 token to query on chainId (after mapping).
   * @param l2Token Optional l2 token address to narrow the balance reporting.
   * @returns Balance of l1Token on chainId.
   */
  getBalanceOnChain(chainId: number, l1Token: string, l2Token?: string): BigNumber {
    const { crossChainTransferClient, relayer, tokenClient } = this;
    let balance: BigNumber;

    // Return the balance for a specific l2 token on the remote chain.
    if (isDefined(l2Token)) {
      balance = tokenClient.getBalance(chainId, l2Token);
      return balance.add(
        crossChainTransferClient.getOutstandingCrossChainTransferAmount(relayer, chainId, l1Token, l2Token)
      );
    }

    const l2Tokens = this.getRemoteTokensForL1Token(l1Token, chainId);
    balance = l2Tokens
      .map((l2Token) => tokenClient.getBalance(chainId, l2Token))
      .reduce((acc, curr) => acc.add(curr), bnZero);

    return balance.add(crossChainTransferClient.getOutstandingCrossChainTransferAmount(this.relayer, chainId, l1Token));
  }

  /**
   * Determine the allocation of an l1 token across all configured remote chain IDs.
   * @param l1Token L1 token to query.
   * @returns Distribution of l1Token by chain ID and l2Token.
   */
  getChainDistribution(l1Token: string): { [chainId: number]: TokenDistribution } {
    const cumulativeBalance = this.getCumulativeBalance(l1Token);
    const distribution: { [chainId: number]: TokenDistribution } = {};

    this.getEnabledChains().forEach((chainId) => {
      // If token doesn't have entry on chain, skip creating an entry for it since we'll likely run into an error
      // later trying to grab the chain equivalent of the L1 token via the HubPoolClient.
      if (chainId === this.hubPoolClient.chainId || this._l1TokenEnabledForChain(l1Token, chainId)) {
        if (cumulativeBalance.eq(bnZero)) {
          return;
        }

        distribution[chainId] ??= {};
        const l2Tokens = this.getRemoteTokensForL1Token(l1Token, chainId);
        l2Tokens.forEach((l2Token) => {
          // The effective balance is the current balance + inbound bridge transfers.
          const effectiveBalance = this.getBalanceOnChain(chainId, l1Token, l2Token);
          distribution[chainId][l2Token] = effectiveBalance.mul(this.scalar).div(cumulativeBalance);
        });
      }
    });
    return distribution;
  }

  /**
   * Determine the allocation of an l1 token across all configured remote chain IDs.
   * @param l1Token L1 token to query.
   * @returns Distribution of l1Token by chain ID and l2Token.
   */
  getTokenDistributionPerL1Token(): TokenDistributionPerL1Token {
    const distributionPerL1Token: TokenDistributionPerL1Token = {};
    this.getL1Tokens().forEach((l1Token) => (distributionPerL1Token[l1Token] = this.getChainDistribution(l1Token)));
    return distributionPerL1Token;
  }

  // Get the balance of a given token on a given chain, including shortfalls and any pending cross chain transfers.
  getCurrentAllocationPct(l1Token: string, chainId: number, l2Token: string): BigNumber {
    // If there is nothing over all chains, return early.
    const cumulativeBalance = this.getCumulativeBalance(l1Token);
    if (cumulativeBalance.eq(bnZero)) {
      return bnZero;
    }

    const shortfall = this.tokenClient.getShortfallTotalRequirement(chainId, l2Token);
    const currentBalance = this.getBalanceOnChain(chainId, l1Token, l2Token).sub(shortfall);

    // Multiply by scalar to avoid rounding errors.
    return currentBalance.mul(this.scalar).div(cumulativeBalance);
  }

  getRepaymentTokenForL1Token(l1Token: string, chainId: number | string): string | undefined {
    // @todo: Update HubPoolClient.getL2TokenForL1TokenAtBlock() such that it returns `undefined` instead of throwing.
    try {
      return this.hubPoolClient.getL2TokenForL1TokenAtBlock(l1Token, Number(chainId));
    } catch {
      return undefined;
    }
  }

  /**
   * From an L1Token and remote chain ID, resolve all supported corresponding tokens.
   * This should include at least the relevant repayment token on the relevant chain, but may also include other
   * "equivalent" tokens (i.e. as with Bridged & Native USDC).
   * @param l1Token Mainnet token to query.
   * @param chainId Remove chain to query.
   * @returns An array of supported tokens on chainId that map back to l1Token on mainnet.
   */
  getRemoteTokensForL1Token(l1Token: string, chainId: number | string): string[] {
    if (chainId === this.hubPoolClient.chainId) {
      return [l1Token];
    }

    const tokenConfig = this.inventoryConfig.tokenConfig[l1Token];
    if (!isDefined(tokenConfig)) {
      return [];
    }

    if (isAliasConfig(tokenConfig)) {
      return Object.keys(tokenConfig).filter((k) => isDefined(tokenConfig[k][chainId]));
    }

    const destinationToken = this.getRepaymentTokenForL1Token(l1Token, chainId);
    if (!isDefined(destinationToken)) {
      return [];
    }

    return [destinationToken];
  }

  getEnabledChains(): number[] {
    return this.chainIdList;
  }

  getEnabledL2Chains(): number[] {
    const hubPoolChainId = this.hubPoolClient.chainId;
    return this.getEnabledChains().filter((chainId) => chainId !== hubPoolChainId);
  }

  getL1Tokens(): string[] {
    return (
      Object.keys(this.inventoryConfig.tokenConfig ?? {}) ||
      this.hubPoolClient.getL1Tokens().map((l1Token) => l1Token.address)
    );
  }

  // Decrement Tokens Balance And Increment Cross Chain Transfer
  trackCrossChainTransfer(l1Token: string, l2Token: string, rebalance: BigNumber, chainId: number | string): void {
    this.tokenClient.decrementLocalBalance(this.hubPoolClient.chainId, l1Token, rebalance);
    this.crossChainTransferClient.increaseOutstandingTransfer(
      this.relayer,
      l1Token,
      l2Token,
      rebalance,
      Number(chainId)
    );
  }

  async getAllBundleRefunds(): Promise<CombinedRefunds[]> {
    const refunds: CombinedRefunds[] = [];
    const [pendingRefunds, nextBundleRefunds] = await Promise.all([
      this.bundleDataClient.getPendingRefundsFromValidBundles(),
      this.bundleDataClient.getNextBundleRefunds(),
    ]);
    refunds.push(...pendingRefunds, ...nextBundleRefunds);
    this.logger.debug({
      at: "InventoryClient#getAllBundleRefunds",
      message: "Remaining refunds from last validated bundle (excludes already executed refunds)",
      refunds: pendingRefunds[0],
    });
    if (nextBundleRefunds.length === 2) {
      this.logger.debug({
        at: "InventoryClient#getAllBundleRefunds",
        message: "Refunds from pending bundle",
        refunds: nextBundleRefunds[0],
      });
      this.logger.debug({
        at: "InventoryClient#getAllBundleRefunds",
        message: "Refunds from upcoming bundle",
        refunds: nextBundleRefunds[1],
      });
    } else {
      this.logger.debug({
        at: "InventoryClient#getAllBundleRefunds",
        message: "Refunds from upcoming bundle",
        refunds: nextBundleRefunds[0],
      });
    }
    return refunds;
  }

  // Return the upcoming refunds (in pending and next bundles) on each chain.
  async getBundleRefunds(l1Token: string): Promise<{ [chainId: string]: BigNumber }> {
    let refundsToConsider: CombinedRefunds[] = [];

    let mark: ReturnType<typeof this.profiler.start>;
    // Increase virtual balance by pending relayer refunds from the latest valid bundle and the
    // upcoming bundle. We can assume that all refunds from the second latest valid bundle have already
    // been executed.
    if (!isDefined(this.bundleRefundsPromise)) {
      // @dev Save this as a promise so that other parallel calls to this function don't make the same call.
      mark = this.profiler.start(`bundleRefunds for ${l1Token}`);
      this.bundleRefundsPromise = this.getAllBundleRefunds();
    }
    refundsToConsider = lodash.cloneDeep(await this.bundleRefundsPromise);
    const totalRefundsPerChain = this.getEnabledChains().reduce(
      (refunds: { [chainId: string]: BigNumber }, chainId) => {
        if (!this.hubPoolClient.l2TokenEnabledForL1Token(l1Token, chainId)) {
          refunds[chainId] = bnZero;
        } else {
          const destinationToken = this.getRepaymentTokenForL1Token(l1Token, chainId);
          refunds[chainId] = this.bundleDataClient.getTotalRefund(
            refundsToConsider,
            this.relayer,
            chainId,
            destinationToken
          );
          return refunds;
        }
        return refunds;
      },
      {}
    );

    mark?.stop({
      message: "Time to calculate total refunds per chain",
      l1Token,
    });

    return totalRefundsPerChain;
  }

  /**
   * Returns possible repayment chain options for a deposit. This is designed to be called by the relayer
   * so that it can batch compute LP fees for all possible repayment chains. By locating this function
   * here it ensures that the relayer and the inventory client are in sync as to which chains are possible
   * repayment chains for a given deposit.
   * @param deposit Deposit
   * @returns list of chain IDs that are possible repayment chains for the deposit.
   */
  getPossibleRepaymentChainIds(deposit: Deposit): number[] {
    // Destination and Origin chain are always included in the repayment chain list.
    const { originChainId, destinationChainId, inputToken } = deposit;
    const chainIds = [originChainId, destinationChainId];
    const l1Token = this.hubPoolClient.getL1TokenInfoForL2Token(inputToken, originChainId).address;

    if (this.isInventoryManagementEnabled()) {
      chainIds.push(...this.getSlowWithdrawalRepaymentChains(l1Token));
    }
    if (![originChainId, destinationChainId].includes(this.hubPoolClient.chainId)) {
      chainIds.push(this.hubPoolClient.chainId);
    }
    return chainIds;
  }

  /**
   * Returns true if the depositor-specified output token is supported by this inventory client.
   * @param deposit V3 Deposit to consider
   * @returns boolean True if output and input tokens are equivalent or if input token is USDC and output token
   * is Bridged USDC.
   */
  validateOutputToken(deposit: Deposit): boolean {
    const { inputToken, outputToken, originChainId, destinationChainId } = deposit;

    // Return true if input and output tokens are mapped to the same L1 token via PoolRebalanceRoutes
    const equivalentTokens = this.hubPoolClient.areTokensEquivalent(
      inputToken,
      originChainId,
      outputToken,
      destinationChainId
    );
    if (equivalentTokens) {
      return true;
    }

    // Return true if input token is Native USDC token and output token is Bridged USDC or if input token
    // is Bridged USDC and the output token is Native USDC.
    // @dev getUsdcSymbol() returns defined if the token on the origin chain is either USDC, USDC.e or USDbC.
    // The contracts should only allow deposits where the input token is the Across-supported USDC variant, so this
    // check specifically handles the case where the input token is Bridged/Native and the output token Native/Bridged.
    const isInputTokenUSDC = isDefined(getUsdcSymbol(inputToken, originChainId));
    const isOutputTokenBridgedUSDC = compareAddressesSimple(
      outputToken,
      TOKEN_SYMBOLS_MAP[destinationChainId === CHAIN_IDs.BASE ? "USDbC" : "USDC.e"].addresses?.[destinationChainId]
    );
    return isInputTokenUSDC && isOutputTokenBridgedUSDC;
  }

  /*
   * Return all eligible repayment chains for a deposit. If inventory management is enabled, then this function will
   * only choose chains where the post-relay balance allocation for a potential repayment chain is under the maximum
   * allowed allocation on that chain. Origin, Destination, and HubChains are always evaluated as potential
   * repayment chains in addition to  "Slow Withdrawal chains" such as Base, Optimism and Arbitrum for which
   * taking repayment would reduce HubPool utilization. Post-relay allocation percentages take into
   * account pending cross-chain inventory-management transfers, upcoming bundle refunds, token shortfalls
   * needed to cover other unfilled deposits in addition to current token balances. Slow withdrawal chains are only
   * selected if the SpokePool's running balance for that chain is over the system's desired target.
   * @dev The HubChain is always evaluated as a fallback option if the inventory management is enabled and all other
   * chains are over-allocated, unless the origin chain is a lite chain, in which case
   * there is no fallback if the origin chain is not an eligible repayment chain.
   * @dev If the origin chain is a lite chain, then only the origin chain is evaluated as a potential repayment chain.
   * @dev If inventory management is disabled, then destinationChain is used as a default unless the
   * originChain is a lite chain, then originChain is the default used.
   * @param deposit Deposit to determine repayment chains for.
   * @param l1Token L1Token linked with deposited inputToken and repayement chain refund token.
   * @returns list of chain IDs that are possible repayment chains for the deposit, sorted from highest
   * to lowest priority.
   */
  async determineRefundChainId(deposit: Deposit, l1Token?: string): Promise<number[]> {
    const { originChainId, destinationChainId, inputToken, outputToken, inputAmount } = deposit;
    const hubChainId = this.hubPoolClient.chainId;

    if (!this.isInventoryManagementEnabled()) {
      return [deposit.fromLiteChain ? originChainId : destinationChainId];
    }

    // The InventoryClient assumes 1:1 equivalency between input and output tokens. At the moment there is no support
    // for disparate output tokens (unless the output token is USDC.e and the input token is USDC),
    // so if one appears here then something is wrong. Throw hard and fast in that case.
    // In future, fills for disparate output tokens should probably just take refunds on the destination chain and
    // outsource inventory management to the operator.
    if (!this.validateOutputToken(deposit)) {
      const [srcChain, dstChain] = [getNetworkName(originChainId), getNetworkName(destinationChainId)];
      throw new Error(
        `Unexpected ${dstChain} output token on ${srcChain} deposit ${deposit.depositId.toString()}` +
          ` (${inputToken} != ${outputToken})`
      );
    }

    l1Token ??= this.hubPoolClient.getL1TokenForL2TokenAtBlock(inputToken, originChainId);

    // Consider any refunds from executed and to-be executed bundles. If bundle data client doesn't return in
    // time, return an object with zero refunds for all chains.
    const totalRefundsPerChain: { [chainId: string]: BigNumber } = await this.getBundleRefunds(l1Token);
    const cumulativeRefunds = Object.values(totalRefundsPerChain).reduce((acc, curr) => acc.add(curr), bnZero);
    const cumulativeVirtualBalance = this.getCumulativeBalance(l1Token);

    // @dev: The following async call to `getExcessRunningBalancePcts` should be very fast compared to the above
    // getBundleRefunds async call. Therefore, we choose not to compute them in parallel.

    // Build list of chains we want to evaluate for repayment:
    const chainsToEvaluate: number[] = [];
    // Add optimistic rollups to front of evaluation list because these are chains with long withdrawal periods
    // that we want to prioritize taking repayment on if the chain is going to end up sending funds back to the
    // hub in the next root bundle over the slow canonical bridge.
    // We need to calculate the latest running balance for each optimistic rollup chain.
    // We'll add the last proposed running balance plus new deposits and refunds.
    if (!deposit.fromLiteChain && this.prioritizeLpUtilization) {
      const excessRunningBalancePcts = await this.getExcessRunningBalancePcts(
        l1Token,
        inputAmount,
        this.getSlowWithdrawalRepaymentChains(l1Token)
      );
      // Sort chains by highest excess percentage over the spoke target, so we can prioritize
      // taking repayment on chains with the most excess balance.
      const chainsWithExcessSpokeBalances = Object.entries(excessRunningBalancePcts)
        .filter(([, pct]) => pct.gt(0))
        .sort(([, pctx], [, pcty]) => bnComparatorDescending(pctx, pcty))
        .map(([chainId]) => Number(chainId));
      chainsToEvaluate.push(...chainsWithExcessSpokeBalances);
    }
    // Add origin chain to take higher priority than destination chain if the destination chain
    // is a lite chain, which should allow the relayer to take more repayments away from the lite chain. Because
    // lite chain deposits force repayment on origin, we end up taking lots of repayment on the lite chain so
    // we should take repayment away from the lite chain where possible.
    if (
      deposit.toLiteChain &&
      !chainsToEvaluate.includes(originChainId) &&
      this._l1TokenEnabledForChain(l1Token, Number(originChainId))
    ) {
      chainsToEvaluate.push(originChainId);
    }
    // Add destination and origin chain if they are not already added.
    // Prioritize destination chain repayment over origin chain repayment but prefer both over
    // hub chain repayment if they are under allocated. We don't include hub chain
    // since its the fallback chain if both destination and origin chain are over allocated.
    // If destination chain is hub chain, we still want to evaluate it before the origin chain.
    if (
      !chainsToEvaluate.includes(destinationChainId) &&
      this._l1TokenEnabledForChain(l1Token, Number(destinationChainId)) &&
      !deposit.fromLiteChain
    ) {
      chainsToEvaluate.push(destinationChainId);
    }
    if (
      !chainsToEvaluate.includes(originChainId) &&
      originChainId !== hubChainId &&
      this._l1TokenEnabledForChain(l1Token, Number(originChainId))
    ) {
      chainsToEvaluate.push(originChainId);
    }

    const eligibleRefundChains: number[] = [];
    // At this point, all chains to evaluate have defined token configs and are sorted in order of
    // highest priority to take repayment on, assuming the chain is under-allocated.
    for (const chainId of chainsToEvaluate) {
      assert(this._l1TokenEnabledForChain(l1Token, chainId), `Token ${l1Token} not enabled for chain ${chainId}`);
      // Destination chain:
      const repaymentToken = this.getRepaymentTokenForL1Token(l1Token, chainId);
      const chainShortfall = this.tokenClient.getShortfallTotalRequirement(chainId, repaymentToken);
      const chainVirtualBalance = this.getBalanceOnChain(chainId, l1Token, repaymentToken);
      const chainVirtualBalanceWithShortfall = chainVirtualBalance.sub(chainShortfall);
      // @dev Do not subtract outputAmount from virtual balance if output token and input token are not equivalent.
      // This is possible when the output token is USDC.e and the input token is USDC which would still cause
      // validateOutputToken() to return true above.
      let chainVirtualBalanceWithShortfallPostRelay =
        chainId === destinationChainId &&
        this.hubPoolClient.areTokensEquivalent(inputToken, originChainId, outputToken, destinationChainId)
          ? chainVirtualBalanceWithShortfall
          : chainVirtualBalanceWithShortfall.add(inputAmount);

      // Add upcoming refunds:
      chainVirtualBalanceWithShortfallPostRelay = chainVirtualBalanceWithShortfallPostRelay.add(
        totalRefundsPerChain[chainId] ?? bnZero
      );
      // To correctly compute the allocation % for this destination chain, we need to add all upcoming refunds for the
      // equivalents of l1Token on all chains.
      const cumulativeVirtualBalancePostRefunds = cumulativeVirtualBalance.add(cumulativeRefunds);

      // Compute what the balance will be on the target chain, considering this relay and the finalization of the
      // transfers that are currently flowing through the canonical bridge.
      const expectedPostRelayAllocation = chainVirtualBalanceWithShortfallPostRelay
        .mul(this.scalar)
        .div(cumulativeVirtualBalancePostRefunds);

      // Consider configured buffer for target to allow relayer to support slight overages.
      const tokenConfig = this.getTokenConfig(l1Token, chainId, repaymentToken);
      if (!isDefined(tokenConfig)) {
        const repaymentChain = getNetworkName(chainId);
        this.logger.debug({
          at: "InventoryClient#determineRefundChainId",
          message: `No token config for ${repaymentToken} on ${repaymentChain}.`,
        });
        if (chainId === destinationChainId) {
          this.logger.debug({
            at: "InventoryClient#determineRefundChainId",
            message: `Will consider to repayment on ${repaymentChain} as destination chain.`,
          });
          eligibleRefundChains.push(chainId);
        }
        continue;
      }

      // It's undesirable to accrue excess balances on a Lite chain because the relayer relies on additional deposits
      // destined for that chain in order to offload its excess.
      const { targetOverageBuffer = DEFAULT_TOKEN_OVERAGE } = tokenConfig;
      const effectiveTargetPct =
        deposit.toLiteChain && chainId === destinationChainId
          ? tokenConfig.targetPct
          : tokenConfig.targetPct.mul(targetOverageBuffer).div(fixedPointAdjustment);

      this.log(
        `Evaluated taking repayment on ${
          chainId === originChainId ? "origin" : chainId === destinationChainId ? "destination" : "slow withdrawal"
        } chain ${chainId} for deposit ${deposit.depositId.toString()}: ${
          expectedPostRelayAllocation.lte(effectiveTargetPct) ? "UNDERALLOCATED ✅" : "OVERALLOCATED ❌"
        }`,
        {
          l1Token,
          originChainId,
          destinationChainId,
          chainShortfall,
          chainVirtualBalance,
          chainVirtualBalanceWithShortfall,
          chainVirtualBalanceWithShortfallPostRelay,
          cumulativeVirtualBalance,
          cumulativeVirtualBalancePostRefunds,
          targetPct: formatUnits(tokenConfig.targetPct, 18),
          targetOverage: formatUnits(targetOverageBuffer, 18),
          effectiveTargetPct: formatUnits(effectiveTargetPct, 18),
          expectedPostRelayAllocation,
          chainsToEvaluate,
        }
      );
      if (expectedPostRelayAllocation.lte(effectiveTargetPct)) {
        eligibleRefundChains.push(chainId);
      }
    }

    // At this point, if the deposit originated on a lite chain, which forces fillers to take repayment on the origin
    // chain, and the origin chain is not an eligible repayment chain, then we shouldn't fill this deposit otherwise
    // the filler will be forced to be over-allocated on the origin chain, which could be very difficult to withdraw
    // funds from.
    // @dev The RHS of this conditional is essentially true if eligibleRefundChains does NOT deep equal [originChainid].
    if (deposit.fromLiteChain && (eligibleRefundChains.length !== 1 || !eligibleRefundChains.includes(originChainId))) {
      return [];
    }

    // Always add hubChain as a fallback option if inventory management is enabled. If none of the chainsToEvaluate
    // were selected, then this function will return just the hub chain as a fallback option.
    if (!eligibleRefundChains.includes(hubChainId)) {
      eligibleRefundChains.push(hubChainId);
    }
    return eligibleRefundChains;
  }

  /**
   * Returns running balances for l1Tokens on all slow withdrawal chains that are enabled for this l1Token.
   * @param l1Token
   * @returns Dictionary keyed by chain ID of the absolute value of the latest running balance for the l1Token.
   */
  private async _getLatestRunningBalances(
    l1Token: string,
    chainsToEvaluate: number[]
  ): Promise<{ [chainId: number]: BigNumber }> {
    const mark = this.profiler.start("getLatestRunningBalances");
    const chainIds = this.hubPoolClient.configStoreClient.getChainIdIndicesForBlock();
    const runningBalances = Object.fromEntries(
      await sdkUtils.mapAsync(chainsToEvaluate, async (chainId) => {
        const chainIdIndex = chainIds.indexOf(chainId);

        // We need to find the latest validated running balance for this chain and token.
        const lastValidatedRunningBalance = this.hubPoolClient.getRunningBalanceBeforeBlockForChain(
          this.hubPoolClient.latestBlockSearched,
          chainId,
          l1Token
        ).runningBalance;

        // Approximate latest running balance for a chain as last known validated running balance...
        // - minus total deposit amount on chain since the latest validated end block
        // - plus total refund amount on chain since the latest validated end block
        const latestValidatedBundle = this.hubPoolClient.getLatestExecutedRootBundleContainingL1Token(
          this.hubPoolClient.latestBlockSearched,
          chainId,
          l1Token
        );
        const l2Token = this.hubPoolClient.getL2TokenForL1TokenAtBlock(l1Token, Number(chainId));

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
          proposedRootBundle = this.hubPoolClient.getLatestFullyExecutedRootBundle(
            latestValidatedBundle.blockNumber // The ProposeRootBundle event must precede the ExecutedRootBundle
            // event we grabbed above. However, it might not exist if the ExecutedRootBundle event is old enough
            // that the preceding ProposeRootBundle is older than the lookback. In this case, leave the
            // last validated bundle end block as 0, since it must be before the earliest lookback block since it was
            // before the ProposeRootBundle event and we can't even find that.
          );
          if (proposedRootBundle) {
            lastValidatedBundleEndBlock = proposedRootBundle.bundleEvaluationBlockNumbers[chainIdIndex].toNumber();
          }
        }
        const upcomingDepositsAfterLastValidatedBundle = this.bundleDataClient.getUpcomingDepositAmount(
          chainId,
          l2Token,
          lastValidatedBundleEndBlock
        );

        // Grab refunds that are not included in any bundle proposed on-chain. These are refunds that have not
        // been accounted for in the latest running balance set in `runningBalanceForToken`.
        const allBundleRefunds = lodash.cloneDeep(await this.bundleRefundsPromise);
        // @dev upcoming refunds are always pushed last into this list, that's why we can pop() it.
        // If a chain didn't exist in the last bundle or a spoke pool client isn't defined, then
        // one of the refund entries for a chain can be undefined.
        const upcomingRefundsAfterLastValidatedBundle = Object.values(
          allBundleRefunds.pop()?.[chainId]?.[l2Token] ?? {}
        ).reduce((acc, curr) => acc.add(curr), bnZero);

        // Updated running balance is last known running balance minus deposits plus upcoming refunds.
        const latestRunningBalance = lastValidatedRunningBalance
          .sub(upcomingDepositsAfterLastValidatedBundle)
          .add(upcomingRefundsAfterLastValidatedBundle);
        // A negative running balance means that the spoke has a balance. If the running balance is positive, then the hub
        // owes it funds and its below target so we don't want to take additional repayment.
        const absLatestRunningBalance = latestRunningBalance.lt(0) ? latestRunningBalance.abs() : toBN(0);
        return [
          chainId,
          {
            absLatestRunningBalance,
            lastValidatedRunningBalance,
            upcomingDeposits: upcomingDepositsAfterLastValidatedBundle,
            upcomingRefunds: upcomingRefundsAfterLastValidatedBundle,
            bundleEndBlock: lastValidatedBundleEndBlock,
            proposedRootBundle: proposedRootBundle?.transactionHash,
          },
        ];
      })
    );
    mark.stop({
      message: `Time to get running balances for ${l1Token}`,
      chainsToEvaluate,
      runningBalances,
    });
    return Object.fromEntries(Object.entries(runningBalances).map(([k, v]) => [k, v.absLatestRunningBalance]));
  }

  /**
   * @param excessRunningBalances Dictionary of "excess" running balances per chain. Running balances
   * are recorded in PoolRebalanceLeaves and are positive if the Hub owes the Spoke funds and negative otherwise.
   * Therefore, running balances can only be considered "excess" if the running balance as recorded in the
   * PoolRebalanceLeaf is negative. This is denoting that the Hub is over-allocated on the Spoke.
   * @param l1Token Token we are comparing running balances for against spoke pool targets.
   * @param refundAmount Amount that will be refunded to the relayer. This value gets subtracted from running
   * balance excesses before comparing with the spoke pool target, since refunds are taken out of spoke pool balances.
   * @returns Dictionary of excess percentages for each chain. The excess percentage is the percentage of the
   * excess running balance over the spoke pool target balance. If the absolute running balance is 0, then
   * the excess percentage is 0. If the target is 0, then the excess percentage is infinite.
   */
  private _getExcessRunningBalancePcts(
    excessRunningBalances: { [chainId: number]: BigNumber },
    l1Token: string,
    refundAmount: BigNumber
  ): { [chainId: number]: BigNumber } {
    const pcts = Object.fromEntries(
      Object.entries(excessRunningBalances).map(([chainId, excess]) => {
        const target = this.hubPoolClient.configStoreClient.getSpokeTargetBalancesForBlock(
          l1Token,
          Number(chainId)
        ).target;
        const excessPostRelay = excess.sub(refundAmount);
        const returnObj = {
          pct: toBN(0),
          target,
          excess,
          excessPostRelay,
        };
        // If target is greater than excess running balance, then pct will
        // be set to 0. If target is 0 then pct is infinite.
        if (target.gte(excessPostRelay)) {
          returnObj.pct = toBN(0);
        } else {
          if (target.eq(0)) {
            returnObj.pct = MAX_UINT_VAL;
          } else {
            // @dev If target is negative, then the denominator will be negative,
            // so we use the .abs() of the denominator to ensure the pct is positive. The
            // numerator will always be positive because in this branch, excessPostRelay > target.
            returnObj.pct = excessPostRelay.sub(target).mul(this.scalar).div(target.abs());
          }
        }
        return [chainId, returnObj];
      })
    );
    this.log(`Computed excess running balances for ${l1Token}`, {
      refundAmount,
      excessRunningBalancePcts: Object.fromEntries(
        Object.entries(pcts).map(([k, v]) => [
          k,
          {
            ...v,
            pct: formatFeePct(v.pct) + "%",
          },
        ])
      ),
    });
    return Object.fromEntries(Object.entries(pcts).map(([k, v]) => [k, v.pct]));
  }

  async getExcessRunningBalancePcts(
    l1Token: string,
    refundAmount: BigNumber,
    chainsToEvaluate: number[]
  ): Promise<{ [chainId: number]: BigNumber }> {
    if (!isDefined(this.excessRunningBalancePromises[l1Token])) {
      // @dev Save this as a promise so that other parallel calls to this function don't make the same call.
      this.excessRunningBalancePromises[l1Token] = this._getLatestRunningBalances(l1Token, chainsToEvaluate);
    }
    const excessRunningBalances = lodash.cloneDeep(await this.excessRunningBalancePromises[l1Token]);
    return this._getExcessRunningBalancePcts(excessRunningBalances, l1Token, refundAmount);
  }

  getPossibleRebalances(): Rebalance[] {
    const chainIds = this.getEnabledL2Chains();
    const rebalancesRequired: Rebalance[] = [];

    for (const l1Token of this.getL1Tokens()) {
      const cumulativeBalance = this.getCumulativeBalance(l1Token);
      if (cumulativeBalance.eq(bnZero)) {
        continue;
      }

      chainIds.forEach((chainId) => {
        // Skip if there's no configuration for l1Token on chainId.
        if (!this._l1TokenEnabledForChain(l1Token, chainId)) {
          return;
        }

        const l2Tokens = this.getRemoteTokensForL1Token(l1Token, chainId);
        l2Tokens.forEach((l2Token) => {
          const currentAllocPct = this.getCurrentAllocationPct(l1Token, chainId, l2Token);
          const tokenConfig = this.getTokenConfig(l1Token, chainId, l2Token);
          if (!isDefined(tokenConfig)) {
            return;
          }

          const { thresholdPct, targetPct } = tokenConfig;
          if (currentAllocPct.gte(thresholdPct)) {
            return;
          }

          const deltaPct = targetPct.sub(currentAllocPct);
          const amount = deltaPct.mul(cumulativeBalance).div(this.scalar);
          const balance = this.tokenClient.getBalance(this.hubPoolClient.chainId, l1Token);
          rebalancesRequired.push({
            chainId,
            l1Token,
            l2Token,
            currentAllocPct,
            thresholdPct,
            targetPct,
            balance,
            cumulativeBalance,
            amount,
          });
        });
      });
    }

    return rebalancesRequired;
  }

  // Trigger a rebalance if the current balance on any L2 chain, including shortfalls, is less than the threshold
  // allocation.
  async rebalanceInventoryIfNeeded(): Promise<void> {
    // Note: these types are just used inside this method, so they are declared in-line.
    type ExecutedRebalance = Rebalance & { hash: string };

    const possibleRebalances: Rebalance[] = [];
    const unexecutedRebalances: Rebalance[] = [];
    const executedTransactions: ExecutedRebalance[] = [];
    try {
      if (!this.isInventoryManagementEnabled()) {
        return;
      }
      const tokenDistributionPerL1Token = this.getTokenDistributionPerL1Token();
      this.constructConsideringRebalanceDebugLog(tokenDistributionPerL1Token);

      const rebalancesRequired = this.getPossibleRebalances();
      if (rebalancesRequired.length === 0) {
        this.log("No rebalances required");
        return;
      }

      // Next, evaluate if we have enough tokens on L1 to actually do these rebalances.
      for (const rebalance of rebalancesRequired) {
        const { balance, amount, l1Token, l2Token, chainId } = rebalance;

        // This is the balance left after any assumed rebalances from earlier loop iterations.
        const unallocatedBalance = this.tokenClient.getBalance(this.hubPoolClient.chainId, l1Token);

        // If the amount required in the rebalance is less than the total amount of this token on L1 then we can execute
        // the rebalance to this particular chain. Note that if the sum of all rebalances required exceeds the l1
        // balance then this logic ensures that we only fill the first n number of chains where we can.
        if (amount.lte(unallocatedBalance)) {
          // As a precautionary step before proceeding, check that the token balance for the token we're about to send
          // hasn't changed on L1. It's possible its changed since we updated the inventory due to one or more of the
          // RPC's returning slowly, leading to concurrent/overlapping instances of the bot running.
          const tokenContract = new Contract(l1Token, ERC20.abi, this.hubPoolClient.hubPool.signer);
          const currentBalance = await tokenContract.balanceOf(this.relayer);

          const balanceChanged = !balance.eq(currentBalance);
          const [message, log] = balanceChanged
            ? ["🚧 Token balance on mainnet changed, skipping rebalance", this.logger.warn]
            : ["Token balance in relayer on mainnet is as expected, sending cross chain transfer", this.logger.debug];
          log({ at: "InventoryClient", message, l1Token, l2Token, l2ChainId: chainId, balance, currentBalance });

          if (!balanceChanged) {
            possibleRebalances.push(rebalance);
            // Decrement token balance in client for this chain and increment cross chain counter.
            this.trackCrossChainTransfer(l1Token, l2Token, amount, chainId);
          }
        } else {
          // Extract unexecutable rebalances for logging.
          unexecutedRebalances.push(rebalance);
        }
      }

      // Extract unexecutable rebalances for logging.

      this.log("Considered inventory rebalances", { rebalancesRequired, possibleRebalances });

      // Finally, execute the rebalances.
      // TODO: The logic below is slow as it waits for each transaction to be included before sending the next one. This
      // should be refactored to enable us to pass an array of transaction objects to the transaction util that then
      // sends each transaction one after the other with incrementing nonce. this will be left for a follow on PR as this
      // is already complex logic and most of the time we'll not be sending batches of rebalance transactions.
      for (const rebalance of possibleRebalances) {
        const { chainId, l1Token, l2Token, amount } = rebalance;
        const { hash } = await this.sendTokenCrossChain(chainId, l1Token, amount, this.simMode, l2Token);
        executedTransactions.push({ ...rebalance, hash });
      }

      // Construct logs on the cross-chain actions executed.
      let mrkdwn = "";

      const groupedRebalances = lodash.groupBy(executedTransactions, "chainId");
      for (const [_chainId, rebalances] of Object.entries(groupedRebalances)) {
        const chainId = Number(_chainId);
        mrkdwn += `*Rebalances sent to ${getNetworkName(chainId)}:*\n`;
        for (const { l2Token, amount, targetPct, thresholdPct, cumulativeBalance, hash, chainId } of rebalances) {
          const tokenInfo = this.hubPoolClient.getTokenInfoForAddress(l2Token, chainId);
          if (!tokenInfo) {
            `InventoryClient::rebalanceInventoryIfNeeded no token info for L2 token ${l2Token} on chain ${chainId}`;
          }
          const { symbol, decimals } = tokenInfo;
          const formatter = createFormatFunction(2, 4, false, decimals);
          mrkdwn +=
            ` - ${formatter(amount.toString())} ${symbol} rebalanced. This meets target allocation of ` +
            `${this.formatWei(targetPct.mul(100).toString())}% (trigger of ` +
            `${this.formatWei(thresholdPct.mul(100).toString())}%) of the total ` +
            `${formatter(
              cumulativeBalance.toString()
            )} ${symbol} over all chains (ignoring hubpool repayments). This chain has a shortfall of ` +
            `${formatter(this.tokenClient.getShortfallTotalRequirement(chainId, l2Token).toString())} ${symbol} ` +
            `tx: ${blockExplorerLink(hash, this.hubPoolClient.chainId)}\n`;
        }
      }

      const groupedUnexecutedRebalances = lodash.groupBy(unexecutedRebalances, "chainId");
      for (const [_chainId, rebalances] of Object.entries(groupedUnexecutedRebalances)) {
        const chainId = Number(_chainId);
        mrkdwn += `*Insufficient amount to rebalance to ${getNetworkName(chainId)}:*\n`;
        for (const { l1Token, l2Token, balance, cumulativeBalance, amount } of rebalances) {
          const tokenInfo = this.hubPoolClient.getTokenInfoForAddress(l2Token, chainId);
          if (!tokenInfo) {
            throw new Error(
              `InventoryClient::rebalanceInventoryIfNeeded no token info for L2 token ${l2Token} on chain ${chainId}`
            );
          }
          const { symbol, decimals } = tokenInfo;
          const formatter = createFormatFunction(2, 4, false, decimals);
          const distributionPct = tokenDistributionPerL1Token[l1Token][chainId][l2Token].mul(100);
          mrkdwn +=
            `- ${symbol} transfer blocked. Required to send ` +
            `${formatter(amount.toString())} but relayer has ` +
            `${formatter(balance.toString())} on L1. There is currently ` +
            `${formatter(this.getBalanceOnChain(chainId, l1Token, l2Token).toString())} ${symbol} on ` +
            `${getNetworkName(chainId)} which is ` +
            `${this.formatWei(distributionPct.toString())}% of the total ` +
            `${formatter(cumulativeBalance.toString())} ${symbol}.` +
            " This chain's pending L1->L2 transfer amount is " +
            `${formatter(
              this.crossChainTransferClient
                .getOutstandingCrossChainTransferAmount(this.relayer, chainId, l1Token, l2Token)
                .toString()
            )}.` +
            ` This chain has a shortfall of ${formatter(
              this.tokenClient.getShortfallTotalRequirement(chainId, l2Token).toString()
            )} ${symbol}.\n`;
        }
      }

      if (mrkdwn) {
        this.log("Executed Inventory rebalances 📒", { mrkdwn }, "info");
      }
    } catch (error) {
      this.log(
        "Something errored during inventory rebalance",
        { error, possibleRebalances, unexecutedRebalances, executedTransactions }, // include all info to help debugging.
        "error"
      );
    }
  }

  async unwrapWeth(): Promise<void> {
    if (!this.isInventoryManagementEnabled()) {
      return;
    }

    // Note: these types are just used inside this method, so they are declared in-line.
    type ChainInfo = {
      chainId: number;
      weth: string;
      unwrapWethThreshold: BigNumber;
      unwrapWethTarget: BigNumber;
      balance: BigNumber;
    };
    type Unwrap = { chainInfo: ChainInfo; amount: BigNumber };
    type ExecutedUnwrap = Unwrap & { hash: string };

    const unwrapsRequired: Unwrap[] = [];
    const unexecutedUnwraps: Unwrap[] = [];
    const executedTransactions: ExecutedUnwrap[] = [];

    try {
      const l1Weth = TOKEN_SYMBOLS_MAP.WETH.addresses[this.hubPoolClient.chainId];
      const chains = await Promise.all(
        this.getEnabledChains()
          .map((chainId) => {
            const tokenConfig = this.getTokenConfig(l1Weth, chainId);
            if (!isDefined(tokenConfig)) {
              return;
            }

            const { unwrapWethThreshold, unwrapWethTarget } = tokenConfig;

            // Ignore chains where ETH isn't the native gas token. Returning null will result in these being filtered.
            if (
              getNativeTokenSymbol(chainId) !== "ETH" ||
              unwrapWethThreshold === undefined ||
              unwrapWethTarget === undefined
            ) {
              return;
            }
            const weth = TOKEN_SYMBOLS_MAP.WETH.addresses[chainId];
            assert(isDefined(weth), `No WETH definition for ${getNetworkName(chainId)}`);

            return { chainId, weth, unwrapWethThreshold, unwrapWethTarget };
          })
          // This filters out all nulls, which removes any chains that are meant to be ignored.
          .filter(isDefined)
          // This map adds the ETH balance to the object.
          .map(async (chainInfo) => ({
            ...chainInfo,
            balance: await this.tokenClient.spokePoolClients[chainInfo.chainId].spokePool.provider.getBalance(
              this.relayer
            ),
          }))
      );

      this.log("Checking WETH unwrap thresholds for chains with thresholds set", { chains });

      chains.forEach((chainInfo) => {
        const { chainId, weth, unwrapWethThreshold, unwrapWethTarget, balance } = chainInfo;
        const l2WethBalance = this.tokenClient.getBalance(chainId, weth);

        if (balance.lt(unwrapWethThreshold)) {
          const amountToUnwrap = unwrapWethTarget.sub(balance);
          const unwrap = { chainInfo, amount: amountToUnwrap };
          if (l2WethBalance.gte(amountToUnwrap)) {
            unwrapsRequired.push(unwrap);
          }
          // Extract unexecutable rebalances for logging.
          else {
            unexecutedUnwraps.push(unwrap);
          }
        }
      });

      this.log("Considered WETH unwraps", { unwrapsRequired, unexecutedUnwraps });

      if (unwrapsRequired.length === 0) {
        this.log("No unwraps required");
        return;
      }

      // Finally, execute the unwraps.
      // TODO: The logic below is slow as it waits for each transaction to be included before sending the next one. This
      // should be refactored to enable us to pass an array of transaction objects to the transaction util that then
      // sends each transaction one after the other with incrementing nonce. this will be left for a follow on PR as this
      // is already complex logic and most of the time we'll not be sending batches of rebalance transactions.
      for (const { chainInfo, amount } of unwrapsRequired) {
        const { chainId, weth } = chainInfo;
        this.tokenClient.decrementLocalBalance(chainId, weth, amount);
        const receipt = await this._unwrapWeth(chainId, weth, amount);
        executedTransactions.push({ chainInfo, amount, hash: receipt.hash });
      }

      // Construct logs on the cross-chain actions executed.
      let mrkdwn = "";

      for (const { chainInfo, amount, hash } of executedTransactions) {
        const { chainId, unwrapWethTarget, unwrapWethThreshold, balance } = chainInfo;
        mrkdwn += `*Unwraps sent to ${getNetworkName(chainId)}:*\n`;
        const formatter = createFormatFunction(2, 4, false, 18);
        mrkdwn +=
          ` - ${formatter(amount.toString())} WETH rebalanced. This meets target ETH balance of ` +
          `${this.formatWei(unwrapWethTarget.toString())} (trigger of ` +
          `${this.formatWei(unwrapWethThreshold.toString())} ETH), ` +
          `current balance of ${this.formatWei(balance.toString())} ` +
          `tx: ${blockExplorerLink(hash, chainId)}\n`;
      }

      for (const { chainInfo, amount } of unexecutedUnwraps) {
        const { chainId, weth } = chainInfo;
        mrkdwn += `*Insufficient amount to unwrap WETH on ${getNetworkName(chainId)}:*\n`;
        const formatter = createFormatFunction(2, 4, false, 18);
        mrkdwn +=
          "- WETH unwrap blocked. Required to send " +
          `${formatter(amount.toString())} but relayer has ` +
          `${formatter(this.tokenClient.getBalance(chainId, weth).toString())} WETH balance.\n`;
      }

      if (mrkdwn) {
        this.log("Executed WETH unwraps 🎁", { mrkdwn }, "info");
      }
    } catch (error) {
      this.log(
        "Something errored during WETH unwrapping",
        { error, unwrapsRequired, unexecutedUnwraps, executedTransactions }, // include all info to help debugging.
        "error"
      );
    }
  }

  constructConsideringRebalanceDebugLog(distribution: TokenDistributionPerL1Token): void {
    const logData: {
      [symbol: string]: {
        [chainId: number]: {
          [l2TokenAddress: string]: {
            actualBalanceOnChain: string;
            virtualBalanceOnChain: string;
            outstandingTransfers: string;
            tokenShortFalls: string;
            proRataShare: string;
          };
        };
      };
    } = {};
    const cumulativeBalances: { [symbol: string]: string } = {};
    Object.entries(distribution).forEach(([l1Token, distributionForToken]) => {
      const tokenInfo = this.hubPoolClient.getTokenInfoForL1Token(l1Token);
      if (tokenInfo === undefined) {
        throw new Error(
          `InventoryClient::constructConsideringRebalanceDebugLog info not found for L1 token ${l1Token}`
        );
      }
      const { symbol, decimals } = tokenInfo;
      const formatter = createFormatFunction(2, 4, false, decimals);
      cumulativeBalances[symbol] = formatter(this.getCumulativeBalance(l1Token).toString());
      logData[symbol] ??= {};

      Object.keys(distributionForToken).forEach((_chainId) => {
        const chainId = Number(_chainId);
        logData[symbol][chainId] ??= {};

        Object.entries(distributionForToken[chainId]).forEach(([l2Token, amount]) => {
          const balanceOnChain = this.getBalanceOnChain(chainId, l1Token, l2Token);
          const transfers = this.crossChainTransferClient.getOutstandingCrossChainTransferAmount(
            this.relayer,
            chainId,
            l1Token,
            l2Token
          );
          const actualBalanceOnChain = this.tokenClient.getBalance(chainId, l2Token);
          logData[symbol][chainId][l2Token] = {
            actualBalanceOnChain: formatter(actualBalanceOnChain.toString()),
            virtualBalanceOnChain: formatter(balanceOnChain.toString()),
            outstandingTransfers: formatter(transfers.toString()),
            tokenShortFalls: formatter(this.tokenClient.getShortfallTotalRequirement(chainId, l2Token).toString()),
            proRataShare: this.formatWei(amount.mul(100).toString()) + "%",
          };
        });
      });
    });

    this.log("Considering rebalance", {
      tokenDistribution: logData,
      cumulativeBalances,
      inventoryConfig: this.inventoryConfig,
    });
  }

  sendTokenCrossChain(
    chainId: number | string,
    l1Token: string,
    amount: BigNumber,
    simMode = false,
    l2Token?: string
  ): Promise<TransactionResponse> {
    return this.adapterManager.sendTokenCrossChain(this.relayer, Number(chainId), l1Token, amount, simMode, l2Token);
  }

  _unwrapWeth(chainId: number, _l2Weth: string, amount: BigNumber): Promise<TransactionResponse> {
    const l2Signer = this.tokenClient.spokePoolClients[chainId].spokePool.signer;
    const l2Weth = new Contract(_l2Weth, WETH_ABI, l2Signer);
    this.log("Unwrapping WETH", { amount: amount.toString() });
    return runTransaction(this.logger, l2Weth, "withdraw", [amount]);
  }

  async setL1TokenApprovals(): Promise<void> {
    if (!this.isInventoryManagementEnabled()) {
      return;
    }
    const l1Tokens = this.getL1Tokens();
    this.log("Checking token approvals", { l1Tokens });
    await this.adapterManager.setL1TokenApprovals(l1Tokens);
  }

  async wrapL2EthIfAboveThreshold(): Promise<void> {
    // If inventoryConfig is defined, there should be a default wrapEtherTarget and wrapEtherThreshold
    // set by RelayerConfig.ts
    if (!this?.inventoryConfig?.wrapEtherThreshold || !this?.inventoryConfig?.wrapEtherTarget) {
      return;
    }
    this.log("Checking ETH->WETH Wrap status");
    await this.adapterManager.wrapEthIfAboveThreshold(this.inventoryConfig, this.simMode);
  }

  update(chainIds?: number[]): Promise<void> {
    if (!this.isInventoryManagementEnabled()) {
      return;
    }

    return this.crossChainTransferClient.update(this.getL1Tokens(), chainIds);
  }

  isInventoryManagementEnabled(): boolean {
    if (this?.inventoryConfig?.tokenConfig && Object.keys(this.inventoryConfig.tokenConfig).length > 0) {
      return true;
    }
    // Use logDisabledManagement to avoid spamming the logs on every check if this module is enabled.
    else if (this.logDisabledManagement == false) {
      this.log("Inventory Management Disabled");
    }
    this.logDisabledManagement = true;
    return false;
  }

  _l1TokenEnabledForChain(l1Token: string, chainId: number): boolean {
    const tokenConfig = this.inventoryConfig?.tokenConfig?.[l1Token];
    if (!isDefined(tokenConfig)) {
      return false;
    }

    // If tokenConfig directly references chainId, token is enabled.
    if (!isAliasConfig(tokenConfig) && isDefined(tokenConfig[chainId])) {
      return true;
    }

    // If any of the mapped symbols reference chainId, token is enabled.
    return Object.keys(tokenConfig).some((symbol) => isDefined(tokenConfig[symbol][chainId]));
  }

  /**
   * @notice Return possible repayment chains for L1 token that have "slow withdrawals" from L2 to L1, so
   * taking repayment on these chains would be done to reduce HubPool utilization and keep funds out of the
   * slow withdrawal canonical bridges.
   * @param l1Token
   * @returns list of chains for l1Token that have a token config enabled and have pool rebalance routes set.
   */
  getSlowWithdrawalRepaymentChains(l1Token: string): number[] {
    return SLOW_WITHDRAWAL_CHAINS.filter(
      (chainId) =>
        this._l1TokenEnabledForChain(l1Token, Number(chainId)) &&
        this.hubPoolClient.l2TokenEnabledForL1Token(l1Token, Number(chainId))
    );
  }

  log(message: string, data?: AnyObject, level: DefaultLogLevels = "debug"): void {
    if (this.logger) {
      this.logger[level]({ at: "InventoryClient", message, ...data });
    }
  }
}

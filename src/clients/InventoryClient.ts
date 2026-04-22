import { utils as sdkUtils } from "@across-protocol/sdk";
import WETH_ABI from "../common/abi/Weth.json";
import {
  acrossApi,
  bnZero,
  BigNumber,
  binanceCredentialsConfigured,
  coingecko,
  defiLlama,
  winston,
  toBN,
  getNetworkName,
  createFormatFunction,
  blockExplorerLink,
  Contract,
  formatUnits,
  submitTransaction,
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
  PriceClient,
  toBNWei,
  assert,
  Profiler,
  getNativeTokenSymbol,
  getInventoryEquivalentL1TokenAddress,
  depositForcesOriginChainRepayment,
  getRemoteTokenForL1Token,
  getTokenInfo,
  isEVMSpokePoolClient,
  EvmAddress,
  Address,
  toAddressType,
  CHAIN_IDs,
  compareAddressesSimple,
  forEachAsync,
  max,
  getLatestRunningBalances,
  getInventoryBalanceContributorTokens,
  dedupArray,
} from "../utils";
import { getAcrossHost } from "./AcrossAPIClient";
import { BinanceClient } from "./BinanceClient";
import { BundleDataApproxClient, BundleDataState } from "./BundleDataApproxClient";
import { HubPoolClient, TokenClient, TransactionClient } from ".";
import { Deposit, TokenInfo } from "../interfaces";
import { InventoryConfig, isAliasConfig, TokenBalanceConfig } from "../interfaces/InventoryManagement";
import lodash from "lodash";
import { hasBinanceRoute, SLOW_WITHDRAWAL_CHAINS } from "../common";
import { AdapterManager, CrossChainTransferClient } from "./bridges";
import { TransferTokenParams } from "../adapter/utils";
import { RebalancerClient } from "../rebalancer/utils/interfaces";

type TokenDistribution = { [l2Token: string]: BigNumber };
type TokenDistributionPerL1Token = { [l1Token: string]: { [chainId: number]: TokenDistribution } };

export type Rebalance = {
  chainId: number;
  l1Token: EvmAddress;
  l2Token: Address;
  // Balance is pushed into the Rebalance object to allow the caller to check if the balance has changed since
  // the rebalance was created.
  balance: BigNumber;
  amount: BigNumber;
  isShortfallRebalance: boolean;
};

const DEFAULT_TOKEN_OVERAGE = toBNWei("1.5");

export type InventoryClientState = {
  bundleDataState: BundleDataState;
  pendingL2Withdrawals: { [l1Token: string]: { [chainId: number]: BigNumber } };
  inventoryConfig: InventoryConfig;
  pendingRebalances: { [chainId: number]: { [token: string]: BigNumber } };
};

export class InventoryClient {
  private logDisabledManagement = false;
  private readonly scalar: BigNumber;
  private readonly formatWei: ReturnType<typeof createFormatFunction>;
  private excessRunningBalancePromises: { [l1Token: string]: Promise<{ [chainId: number]: BigNumber }> } = {};
  private profiler: InstanceType<typeof Profiler>;
  private bundleDataApproxClient: BundleDataApproxClient;
  private inventoryConfig: InventoryConfig;
  private pendingL2Withdrawals: { [l1Token: string]: { [chainId: number]: BigNumber } } = {};
  private pendingRebalances: { [chainId: number]: { [token: string]: BigNumber } } = {};
  private transactionClient: TransactionClient;
  // Headroom multiplier on CEX quota; RELAYER_CEX_REBALANCE_BUFFER overrides (default 3x).
  private readonly cexRebalanceBuffer: BigNumber;
  private readonly priceClient: PriceClient | undefined;
  protected l1TokenPricesUsd: Map<string, BigNumber> = new Map();

  constructor(
    readonly relayer: EvmAddress,
    readonly logger: winston.Logger,
    inventoryConfig: InventoryConfig,
    readonly tokenClient: TokenClient,
    readonly chainIdList: number[],
    readonly hubPoolClient: HubPoolClient,
    readonly adapterManager: AdapterManager,
    readonly crossChainTransferClient: CrossChainTransferClient,
    readonly rebalancerClient: RebalancerClient,
    readonly simMode = false,
    readonly prioritizeLpUtilization = true,
    readonly l1TokensOverride: string[] = [],
    protected binanceClient?: BinanceClient
  ) {
    this.transactionClient = new TransactionClient(logger);
    this.inventoryConfig = inventoryConfig;
    this.scalar = sdkUtils.fixedPointAdjustment;
    const rawBuffer = Number(process.env.RELAYER_CEX_REBALANCE_BUFFER);
    this.cexRebalanceBuffer = toBNWei(Number.isFinite(rawBuffer) && rawBuffer > 0 ? rawBuffer : 3);
    if (binanceCredentialsConfigured()) {
      this.priceClient = new PriceClient(logger, [
        new acrossApi.PriceFeed({ host: getAcrossHost(this.hubPoolClient.chainId) }),
        new coingecko.PriceFeed({ apiKey: process.env.COINGECKO_PRO_API_KEY }),
        new defiLlama.PriceFeed(),
      ]);
    }
    this.formatWei = createFormatFunction(2, 4, false, 18);
    this.profiler = new Profiler({
      logger: this.logger,
      at: "InventoryClient",
    });
    // Load all L1 tokens from inventory config and hub pool into a Set to deduplicate.
    const allL1Tokens = new Set<string>(
      this.l1TokensOverride.length > 0
        ? this.l1TokensOverride
        : this.getL1TokensFromInventoryConfig()
            .concat(this.getL1TokensEnabledInHubPool())
            .map((l1Token) => l1Token.toNative())
    );
    this.bundleDataApproxClient = new BundleDataApproxClient(
      this.tokenClient?.spokePoolManager.getSpokePoolClients() ?? {},
      this.hubPoolClient,
      this.chainIdList,
      Array.from(allL1Tokens.values()).map((l1Token) => EvmAddress.from(l1Token)),
      this.logger
    );
  }

  /**
   * Export current InventoryClient state.
   * @returns InventoryClient state. This can be subsequently ingested by InventoryClient.import().
   */
  export(): InventoryClientState {
    const { upcomingDeposits, upcomingRefunds } = this.bundleDataApproxClient.export();
    const state = {
      inventoryConfig: this.inventoryConfig,
      bundleDataState: {
        upcomingDeposits,
        upcomingRefunds,
      },
      pendingL2Withdrawals: this.pendingL2Withdrawals,
      pendingRebalances: this.pendingRebalances,
    };

    this.logger.debug({ at: "InventoryClient::export", message: "Exported inventory client state." });
    return state;
  }

  /**
   * Import InventoryClient state.
   * @returns void
   */
  import(state: InventoryClientState) {
    const { bundleDataState, pendingL2Withdrawals, pendingRebalances } = state;
    this.inventoryConfig = state.inventoryConfig;
    this.bundleDataApproxClient.import(bundleDataState);
    this.pendingL2Withdrawals = pendingL2Withdrawals;
    this.pendingRebalances = pendingRebalances;
    this.logger.debug({ at: "InventoryClient::import", message: "Imported inventory client state." });
  }

  /**
   * Get the cache key for the InventoryClient state.
   * @returns Cache key for the InventoryClient state
   */
  getInventoryCacheKey(inventoryTopic: string): string {
    return `${inventoryTopic}-${this.relayer}`;
  }
  protected getTokenInfo(token: Address, chainId: number): TokenInfo {
    return getTokenInfo(token, chainId);
  }

  /**
   * Resolve the token balance configuration for `l1Token` on `chainId`. If `l1Token` maps to multiple tokens on
   * `chainId` then `l2Token` must be supplied.
   * @param l1Token L1 token address to query.
   * @param chainId Chain ID to query on
   * @param l2Token Optional L2 token address when l1Token maps to multiple l2Token addresses.
   */
  getTokenConfig(l1Token: EvmAddress, chainId: number, l2Token?: Address): TokenBalanceConfig | undefined {
    const tokenConfig = this.inventoryConfig.tokenConfig[l1Token.toEvmAddress()];
    if (!isDefined(tokenConfig)) {
      return;
    }

    if (isAliasConfig(tokenConfig)) {
      assert(isDefined(l2Token), `Cannot resolve ambiguous ${getNetworkName(chainId)} token config for ${l1Token}`);
      return tokenConfig[l2Token.toNative()]?.[chainId];
    } else {
      return tokenConfig[chainId];
    }
  }

  supportsSwaps(): boolean {
    return (this.inventoryConfig?.allowedSwapRoutes ?? []).length > 0;
  }

  isSwapSupported(inputToken: Address, outputToken: Address, inputChainId: number, outputChainId: number): boolean {
    if (!this.supportsSwaps()) {
      return false;
    }
    return this.inventoryConfig.allowedSwapRoutes.some(
      (swapRoute) =>
        (swapRoute.fromChain === "ALL" || swapRoute.fromChain === inputChainId) &&
        swapRoute.fromToken === inputToken.toNative() &&
        (swapRoute.toChain === "ALL" || swapRoute.toChain === outputChainId) &&
        swapRoute.toToken === outputToken.toNative()
    );
  }

  /*
   * Get the total balance for an L1 token across all chains, considering any outstanding cross chain transfers as a
   * virtual balance on that chain.
   * @notice Returns the balance in the decimals of the L1 token.
   * @param l1Token L1 token address to query.
   * returns Cumulative balance of l1Token across all inventory-managed chains.
   */
  getCumulativeBalance(l1Token: EvmAddress): BigNumber {
    return this.getEnabledChains()
      .map((chainId) => this.getBalanceOnChain(chainId, l1Token))
      .reduce((acc, curr) => acc.add(curr), bnZero);
  }

  /**
   * Returns cumulative balance along with approximate upcoming refunds. Refund balances are normalized to
   * the L1 token decimals.
   * @param l1Token
   * @returns Cumulative balance plus approximate upcoming refunds.
   */
  getCumulativeBalanceWithApproximateUpcomingRefunds(l1Token: EvmAddress): BigNumber {
    const totalRefundsPerChain: { [chainId: number]: BigNumber } = {};
    for (const chainId of this.chainIdList) {
      const refundAmount = this.getUpcomingRefunds(chainId, l1Token, this.relayer);
      totalRefundsPerChain[chainId] = refundAmount;
    }
    const cumulativeRefunds = Object.values(totalRefundsPerChain).reduce((acc, curr) => acc.add(curr), bnZero);
    const cumulativeVirtualBalance = this.getCumulativeBalance(l1Token);
    return cumulativeVirtualBalance.add(cumulativeRefunds);
  }

  getChainBalance(
    chainId: number,
    l1Token: EvmAddress,
    l2Token?: Address,
    ignoreL1ToL2PendingAmount = false
  ): BigNumber {
    return this.getBalanceOnChain(chainId, l1Token, l2Token, ignoreL1ToL2PendingAmount);
  }

  /**
   * Determine the effective/virtual balance of an l1 token that has been deployed to another chain.
   * Includes both the actual balance on the chain and any pending inbound transfers to the target chain.
   * If l2Token is supplied, return its balance on the specified chain. Otherwise, return the total allocation
   * of l1Token on the specified chain.
   * @notice Returns the balance of the tokens normalized to the L1 token decimals, which matters if the L2 token
   * decimals differs from the L1 token decimals.
   * @param chainId Chain to query token balance on.
   * @param l1Token L1 token to query on chainId (after mapping).
   * @param l2Token Optional l2 token address to narrow the balance reporting.
   * @returns Balance of l1Token on chainId.
   */
  protected getBalanceOnChain(
    chainId: number,
    l1Token: EvmAddress,
    l2Token?: Address,
    ignoreL1ToL2PendingAmount = false
  ): BigNumber {
    const { crossChainTransferClient, relayer, tokenClient } = this;
    let balance = bnZero;

    const { decimals: l1TokenDecimals, symbol: l1TokenSymbol } = this.getTokenInfo(l1Token, this.hubPoolClient.chainId);

    // If chain is L1, add all pending L2->L1 withdrawals.
    if (chainId === this.hubPoolClient.chainId) {
      const pendingL2WithdrawalsForL1Token = this.pendingL2Withdrawals[l1Token.toNative()];
      if (isDefined(pendingL2WithdrawalsForL1Token)) {
        const pendingWithdrawalVolume = Object.values(pendingL2WithdrawalsForL1Token).reduce(
          (acc, curr) => acc.add(curr),
          bnZero
        );
        balance = pendingWithdrawalVolume;
      }
    }

    // Add in any pending swap rebalances. Pending Rebalances are currently only supported for the canonical L2 tokens
    // mapped to each L1 token (i.e. the L2 token for an L1 token returned by getRemoteTokenForL1Token())
    const pendingRebalancesForChain = this.pendingRebalances[chainId];
    const canonicalL2Token = getRemoteTokenForL1Token(l1Token, chainId, this.hubPoolClient.chainId);
    if (
      isDefined(pendingRebalancesForChain) &&
      isDefined(canonicalL2Token) &&
      (!isDefined(l2Token) || l2Token.eq(canonicalL2Token))
    ) {
      const { decimals: l2TokenDecimals } = this.getTokenInfo(canonicalL2Token, chainId);
      const pendingRebalancesForToken = pendingRebalancesForChain[l1TokenSymbol];
      if (isDefined(pendingRebalancesForToken)) {
        balance = balance.add(sdkUtils.ConvertDecimals(l2TokenDecimals, l1TokenDecimals)(pendingRebalancesForToken));
      }
    }

    // Return the balance for a specific l2 token on the remote chain.
    if (isDefined(l2Token)) {
      const { decimals: l2TokenDecimals } = this.getTokenInfo(l2Token, chainId);
      balance = balance.add(
        sdkUtils.ConvertDecimals(l2TokenDecimals, l1TokenDecimals)(tokenClient.getBalance(chainId, l2Token))
      );
      return balance.add(
        ignoreL1ToL2PendingAmount
          ? bnZero
          : crossChainTransferClient.getOutstandingCrossChainTransferAmount(relayer, chainId, l1Token, l2Token)
      );
    }

    const l2Tokens = this.getRemoteTokensForL1Token(l1Token, chainId);
    balance = balance.add(
      l2Tokens
        .map((l2Token) => {
          const { decimals: l2TokenDecimals } = this.getTokenInfo(l2Token, chainId);
          return sdkUtils.ConvertDecimals(l2TokenDecimals, l1TokenDecimals)(tokenClient.getBalance(chainId, l2Token));
        })
        .reduce((acc, curr) => acc.add(curr), bnZero)
    );

    return balance.add(
      ignoreL1ToL2PendingAmount
        ? bnZero
        : crossChainTransferClient.getOutstandingCrossChainTransferAmount(this.relayer, chainId, l1Token)
    );
  }

  /**
   * Determine the allocation of an l1 token across all configured remote chain IDs.
   * @param l1Token L1 token to query.
   * @returns Distribution of l1Token by chain ID and l2Token.
   */
  private getChainDistribution(l1Token: EvmAddress): { [chainId: number]: TokenDistribution } {
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
          distribution[chainId][l2Token.toNative()] = effectiveBalance.mul(this.scalar).div(cumulativeBalance);
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
    this.getL1Tokens().forEach(
      (l1Token) => (distributionPerL1Token[l1Token.toNative()] = this.getChainDistribution(l1Token))
    );
    return distributionPerL1Token;
  }

  // Get the balance of a given token on a given chain, including shortfalls and any pending cross chain transfers.
  getCurrentAllocationPct(
    l1Token: EvmAddress,
    chainId: number,
    l2Token: Address,
    ignoreL1ToL2PendingAmount = false,
    ignoreShortfall = false
  ): BigNumber {
    // If there is nothing over all chains, return early.
    const cumulativeBalance = this.getCumulativeBalance(l1Token);
    if (cumulativeBalance.eq(bnZero)) {
      return bnZero;
    }

    const { decimals: l2TokenDecimals } = this.getTokenInfo(l2Token, chainId);
    const { decimals: l1TokenDecimals } = this.getTokenInfo(l1Token, this.hubPoolClient.chainId);
    const shortfall = sdkUtils.ConvertDecimals(
      l2TokenDecimals,
      l1TokenDecimals
    )(this.tokenClient.getShortfallTotalRequirement(chainId, l2Token));
    const currentBalance = this.getBalanceOnChain(chainId, l1Token, l2Token, ignoreL1ToL2PendingAmount).sub(
      ignoreShortfall ? bnZero : shortfall
    );

    // Multiply by scalar to avoid rounding errors.
    return currentBalance.mul(this.scalar).div(cumulativeBalance);
  }

  protected getRemoteTokenForL1Token(l1Token: EvmAddress, chainId: number): Address | undefined {
    return chainId === this.hubPoolClient.chainId
      ? l1Token
      : getRemoteTokenForL1Token(l1Token, chainId, this.hubPoolClient.chainId);
  }

  /**
   * From an L1Token and remote chain ID, resolve all supported corresponding tokens.
   * This should include at least the relevant repayment token on the relevant chain, but may also include other
   * "equivalent" tokens (i.e. as with Bridged & Native USDC) as defined by a custom token configuration.
   * @param l1Token Mainnet token to query.
   * @param chainId Remove chain to query.
   * @returns An array of supported tokens on chainId that map back to l1Token on mainnet.
   */
  getRemoteTokensForL1Token(l1Token: EvmAddress, chainId: number): Address[] {
    if (chainId === this.hubPoolClient.chainId) {
      return [l1Token];
    }

    const tokenConfig = this.inventoryConfig.tokenConfig[l1Token.toNative()];
    if (!isDefined(tokenConfig)) {
      return [];
    }

    if (isAliasConfig(tokenConfig)) {
      return Object.keys(tokenConfig)
        .filter((k) => isDefined(tokenConfig[k][chainId]))
        .map((token) => toAddressType(token, chainId));
    }

    const inventoryEquivalentTokens = getInventoryBalanceContributorTokens(
      l1Token,
      chainId,
      this.hubPoolClient.chainId
    );
    if (inventoryEquivalentTokens.length === 0) {
      return [];
    }

    return inventoryEquivalentTokens;
  }

  getEnabledChains(): number[] {
    return this.chainIdList;
  }

  getEnabledL2Chains(): number[] {
    const hubPoolChainId = this.hubPoolClient.chainId;
    return this.getEnabledChains().filter((chainId) => chainId !== hubPoolChainId);
  }

  getL1Tokens(): EvmAddress[] {
    return this.inventoryConfig?.tokenConfig
      ? this.getL1TokensFromInventoryConfig()
      : this.getL1TokensEnabledInHubPool();
  }

  getL1TokensFromInventoryConfig(): EvmAddress[] {
    return Object.keys(this.inventoryConfig?.tokenConfig ?? {}).map((token) => EvmAddress.from(token));
  }

  getL1TokensEnabledInHubPool(): EvmAddress[] {
    return this.hubPoolClient.getL1Tokens().map((l1Token) => l1Token.address);
  }

  // Decrement Tokens Balance And Increment Cross Chain Transfer
  trackCrossChainTransfer(l1Token: EvmAddress, l2Token: Address, rebalance: BigNumber, chainId: number): void {
    this.tokenClient.decrementLocalBalance(this.hubPoolClient.chainId, l1Token, rebalance);
    this.crossChainTransferClient.increaseOutstandingTransfer(this.relayer, l1Token, l2Token, rebalance, chainId);
  }

  setBundleData(): void {
    this.bundleDataApproxClient.initialize();
  }

  getUpcomingRefunds(chainId: number, l1Token: EvmAddress, relayer?: EvmAddress): BigNumber {
    return this.bundleDataApproxClient.getUpcomingRefunds(chainId, l1Token, relayer);
  }

  /**
   * Returns possible repayment chain options for a deposit. This is designed to be called by the relayer
   * so that it can batch compute LP fees for all possible repayment chains. By locating this function
   * here it ensures that the relayer and the inventory client are in sync as to which chains are possible
   * repayment chains for a given deposit.
   * @param deposit Deposit
   * @returns list of chain IDs that are possible repayment chains for the deposit.
   */
  /**
   * Determines if origin chain repayment is forced for a deposit.
   * Priority: forceOriginRepaymentPerChain[originChainId] > forceOriginRepayment > protocol rules
   * @param deposit The deposit to check
   * @returns true if origin chain repayment is forced
   */
  shouldForceOriginRepayment(deposit: Deposit): boolean {
    const protocolForcesOriginRepayment = depositForcesOriginChainRepayment(deposit, this.hubPoolClient);
    const perChainForceOriginRepayment = this.inventoryConfig?.forceOriginRepaymentPerChain?.[deposit.originChainId];
    const globalForceOriginRepayment = this.inventoryConfig?.forceOriginRepayment ?? false;
    // Per-chain config takes priority over global config
    const configForcesOriginRepayment = perChainForceOriginRepayment ?? globalForceOriginRepayment;
    return protocolForcesOriginRepayment || configForcesOriginRepayment;
  }

  /**
   * Gets the repayment chain override for a given origin chain.
   * Priority: repaymentChainOverridePerChain[originChainId] > repaymentChainOverride
   * @param originChainId The origin chain ID
   * @returns The repayment chain override chain ID, or undefined if not set
   */
  private getRepaymentChainOverride(originChainId: number): number | undefined {
    const perChainRepaymentOverride = this.inventoryConfig?.repaymentChainOverridePerChain?.[originChainId];
    const globalRepaymentOverride = this.inventoryConfig?.repaymentChainOverride;
    return perChainRepaymentOverride ?? globalRepaymentOverride;
  }

  getPossibleRepaymentChainIds(deposit: Deposit): number[] {
    // Origin chain is always included in the repayment chain list.
    const { originChainId, destinationChainId, inputToken } = deposit;
    const chainIds = new Set<number>();
    chainIds.add(originChainId);

    // Check if origin chain repayment is forced by protocol rules or config overrides
    const forceOriginRepayment = this.shouldForceOriginRepayment(deposit);

    if (forceOriginRepayment) {
      return [originChainId];
    }

    if (this.canTakeDestinationChainRepayment(deposit)) {
      chainIds.add(destinationChainId);
    }

    if (this.isInventoryManagementEnabled()) {
      // @dev Because the `deposit` is for an input token that has already been filtered, this mapping should exist.
      const l1Token = this.getRequiredL1TokenAddress(inputToken, originChainId);
      this.getSlowWithdrawalRepaymentChains(l1Token).forEach((chainId) => {
        if (this.hubPoolClient.l2TokenEnabledForL1Token(l1Token, chainId)) {
          chainIds.add(chainId);
        }
      });
    }
    // Check per-chain override first, then global override
    const chainOverride = this.getRepaymentChainOverride(originChainId);
    if (isDefined(chainOverride)) {
      chainIds.add(chainOverride);
    }

    chainIds.add(this.hubPoolClient.chainId);
    return [...chainIds];
  }

  /**
   * Returns the L1 token address for a given L2 token address on a given chain. Returns undefined
   *  if the l2 token and chain ID do not not have a corresponding L1 token mapping.
   * @param l2Token L2 token address
   * @param chainId Chain ID
   * @returns L1 token address from TokenSymbolsMap or undefined if the l2 token and chain ID do not not have a corresponding L1 token mapping.
   */
  getL1TokenAddress(l2Token: Address, chainId: number): EvmAddress | undefined {
    try {
      return getInventoryEquivalentL1TokenAddress(l2Token, chainId, this.hubPoolClient.chainId);
    } catch {
      return undefined;
    }
  }

  private getRequiredL1TokenAddress(originToken: Address, originChainId: number): EvmAddress {
    const l1Token = this.getL1TokenAddress(originToken, originChainId);
    assert(
      isDefined(l1Token),
      `InventoryClient#getRequiredL1TokenAddress: No L1 token found for origin token ${originToken.toNative()} on origin chain ${originChainId}`
    );
    return l1Token;
  }

  /**
   * Returns true if the depositor-specified output token is supported by this inventory client.
   * @param deposit Deposit to consider
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

    // Return true if the input and output tokens are defined as equivalent according to a user-defined swap config.
    if (this.isSwapSupported(inputToken, outputToken, originChainId, destinationChainId)) {
      return true;
    }

    // Return true if the input and output token are defined as equivalent according to a hardcoded mapping
    // of equivalent tokens. This should allow relayer to define which tokens it should be able to fill despite them
    // not being linked via a PoolRebalanceRoute.
    const l1TokenMappedToInputToken = this.getL1TokenAddress(inputToken, originChainId);
    const l1TokenMappedToOutputToken = this.getL1TokenAddress(outputToken, destinationChainId);
    if (!isDefined(l1TokenMappedToInputToken) || !isDefined(l1TokenMappedToOutputToken)) {
      return false;
    }
    return l1TokenMappedToInputToken.eq(l1TokenMappedToOutputToken);
  }

  /**
   * @notice Returns true if the deposit has an output token PoolRebalanceRoute mapping equivalent to the input token's
   * PoolRebalanceRoute mapping.
   */
  canTakeDestinationChainRepayment(
    deposit: Pick<Deposit, "inputToken" | "originChainId" | "outputToken" | "destinationChainId" | "fromLiteChain">
  ): boolean {
    if (depositForcesOriginChainRepayment(deposit, this.hubPoolClient)) {
      return false;
    }
    const hubPoolBlock = this.hubPoolClient.latestHeightSearched;
    if (!this.hubPoolClient.l2TokenHasPoolRebalanceRoute(deposit.inputToken, deposit.originChainId, hubPoolBlock)) {
      return false;
    }
    const l1Token = this.hubPoolClient.getL1TokenForL2TokenAtBlock(
      deposit.inputToken,
      deposit.originChainId,
      hubPoolBlock
    );
    return this.hubPoolClient.l2TokenEnabledForL1TokenAtBlock(l1Token, deposit.destinationChainId, hubPoolBlock);
  }

  /**
   * @notice Return eligible repayment chains for a deposit.
   * @dev This function implements a four-stage pipeline for determining eligible repayment chains:
   * - possibleChains: the authoritative superset from getPossibleRepaymentChainIds(deposit)
   * - candidateChains: possibleChains minus chains that should not be allocation-evaluated
   * - rankedChains: candidateChains ordered by current repayment priority rules
   * - eligibleChains: rankedChains that pass the allocation check
   * @param deposit Deposit to determine repayment chains for.
   * @returns list of chain IDs that are possible repayment chains for the deposit, sorted from highest
   * to lowest priority.
   */
  async determineRefundChainId(deposit: Deposit): Promise<number[]> {
    const { originChainId, destinationChainId, inputToken, outputToken, inputAmount } = deposit;
    const hubChainId = this.hubPoolClient.chainId;

    if (sdkUtils.invalidOutputToken(deposit)) {
      return [];
    }

    if (!this.isInventoryManagementEnabled()) {
      return [!this.canTakeDestinationChainRepayment(deposit) ? originChainId : destinationChainId];
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

    // Check if origin chain repayment is forced by protocol rules or config overrides
    const forceOriginRepayment = this.shouldForceOriginRepayment(deposit);
    const originQuickRebalance = this.isQuicklyRebalanced(originChainId, inputToken);

    // Force-origin deposits with an unmetered fast-rebalance route (CCTP/OFT/hub) skip allocation checks.
    // Binance-route origins are handled downstream with capacity gating.
    if (forceOriginRepayment && this.isUnmeteredFastRebalance(originChainId, inputToken)) {
      return [originChainId];
    }

    // @dev This mapping should exist because `validateOutputToken()` would already have returned false if the
    // input token and origin chain were not mapped to an L1 token.
    const l1Token = this.getRequiredL1TokenAddress(inputToken, originChainId);

    // If we have defined an override repayment chain in inventory config and we do not need to take origin chain repayment,
    // then short-circuit this check.
    // Priority: repaymentChainOverridePerChain[originChainId] > repaymentChainOverride
    if (!forceOriginRepayment) {
      const chainOverride = this.getRepaymentChainOverride(originChainId);
      if (isDefined(chainOverride)) {
        return [chainOverride];
      }
    }

    const { decimals: l1TokenDecimals } = this.getTokenInfo(l1Token, this.hubPoolClient.chainId);
    const { decimals: inputTokenDecimals } = this.getTokenInfo(inputToken, originChainId);
    const inputAmountInL1TokenDecimals = sdkUtils.ConvertDecimals(inputTokenDecimals, l1TokenDecimals)(inputAmount);

    // Prefer origin when it's a fast-rebalance source with capacity for this fill — ignore allocation.
    if (
      this._l1TokenEnabledForChain(l1Token, originChainId) &&
      this.canFastRebalanceFill(originChainId, inputToken, l1Token, inputAmountInL1TokenDecimals, l1TokenDecimals)
    ) {
      return [originChainId];
    }

    const totalRefundsPerChain: { [chainId: number]: BigNumber } = Object.fromEntries(
      this.chainIdList.map((chainId) => [chainId, this.getUpcomingRefunds(chainId, l1Token, this.relayer)])
    );
    const destinationTokensAreEquivalent = this.hubPoolClient.areTokensEquivalent(
      inputToken,
      originChainId,
      outputToken,
      destinationChainId
    );
    // To correctly compute destination-chain allocation, add upcoming refunds for all equivalents of this L1 token.
    const cumulativeVirtualBalancePostRefunds = this.getCumulativeBalanceWithApproximateUpcomingRefunds(l1Token);

    // Build the refund-chain pipeline from the public superset used by the relayer for LP fee precomputation.
    const possibleChains = this.getPossibleRepaymentChainIds(deposit);
    const prioritizeOrigin = deposit.toLiteChain || originQuickRebalance;
    const slowWithdrawalRepaymentChains = this.getSlowWithdrawalRepaymentChains(l1Token);
    const slowWithdrawalRepaymentChainSet = new Set(slowWithdrawalRepaymentChains);

    // @dev The async call to `getExcessRunningBalancePcts` should be very fast compared to upcoming refund lookups,
    // so we choose not to compute them in parallel.
    const excessRunningBalancePcts =
      !forceOriginRepayment && this.prioritizeLpUtilization
        ? await this.getExcessRunningBalancePcts(l1Token, inputAmountInL1TokenDecimals, slowWithdrawalRepaymentChains)
        : {};

    const slowWithdrawalCandidateChains = possibleChains
      .filter(
        (chainId) =>
          slowWithdrawalRepaymentChainSet.has(chainId) && (excessRunningBalancePcts[chainId] ?? bnZero).gt(bnZero)
      )
      .sort((chainIdx, chainIdy) =>
        bnComparatorDescending(excessRunningBalancePcts[chainIdx], excessRunningBalancePcts[chainIdy])
      );

    const standardChainOrder = prioritizeOrigin
      ? [originChainId, destinationChainId]
      : [destinationChainId, originChainId];
    const canEvaluateOrigin =
      this._l1TokenEnabledForChain(l1Token, originChainId) && (prioritizeOrigin || originChainId !== hubChainId);
    const canEvaluateDestination =
      this.canTakeDestinationChainRepayment(deposit) && this._l1TokenEnabledForChain(l1Token, destinationChainId);
    const standardCandidateChains = [...standardChainOrder].filter((chainId) =>
      chainId === originChainId ? canEvaluateOrigin : canEvaluateDestination
    );
    const rankedChains = dedupArray([...slowWithdrawalCandidateChains, ...standardCandidateChains]);

    const eligibleChains: number[] = [];
    // At this point, all ranked chains have defined token configs or are destination chains that can be accepted
    // without config, and are ordered from highest to lowest repayment priority.
    for (const chainId of rankedChains) {
      assert(this._l1TokenEnabledForChain(l1Token, chainId), `Token ${l1Token} not enabled for chain ${chainId}`);

      const repaymentToken = chainId === originChainId ? inputToken : this.getRemoteTokenForL1Token(l1Token, chainId);
      if (chainId !== originChainId) {
        assert(
          this.hubPoolClient.l2TokenHasPoolRebalanceRoute(repaymentToken, chainId),
          `Token ${repaymentToken} not enabled as PoolRebalanceRoute for chain ${chainId} for l1 token ${l1Token}`
        );
      }
      const { decimals: l2TokenDecimals } = this.getTokenInfo(repaymentToken, chainId);
      const chainShortfall = sdkUtils.ConvertDecimals(
        l2TokenDecimals,
        l1TokenDecimals
      )(this.tokenClient.getShortfallTotalRequirement(chainId, repaymentToken));
      const chainVirtualBalance = this.getBalanceOnChain(chainId, l1Token, repaymentToken);
      const chainVirtualBalanceWithShortfall = chainVirtualBalance.sub(chainShortfall);
      const inputAmountAddedPostRelay =
        chainId === destinationChainId && destinationTokensAreEquivalent ? bnZero : inputAmountInL1TokenDecimals;
      const chainVirtualBalanceWithShortfallPostRelay = chainVirtualBalanceWithShortfall
        .add(inputAmountAddedPostRelay)
        .add(totalRefundsPerChain[chainId] ?? bnZero);
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
            message: `Will consider to take repayment on ${repaymentChain} as destination chain.`,
          });
          eligibleChains.push(chainId);
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
          cumulativeVirtualBalancePostRefunds,
          targetPct: formatUnits(tokenConfig.targetPct, 18),
          targetOverage: formatUnits(targetOverageBuffer, 18),
          effectiveTargetPct: formatUnits(effectiveTargetPct, 18),
          expectedPostRelayAllocation,
          rankedChains,
        }
      );
      if (expectedPostRelayAllocation.lte(effectiveTargetPct)) {
        eligibleChains.push(chainId);
      }
    }

    // At this point, if the deposit originated on a lite chain, which forces fillers to take repayment on the origin
    // chain, and the origin chain is not an eligible repayment chain, then we shouldn't fill this deposit otherwise
    // the filler will be forced to be over-allocated on the origin chain, which could be very difficult to withdraw
    // funds from.
    // @dev The RHS of this conditional is essentially true if eligibleChains does NOT deep equal [originChainId].
    if (forceOriginRepayment && (eligibleChains.length !== 1 || !eligibleChains.includes(originChainId))) {
      return [];
    }

    // Conditionally add the origin chain as a fallback option if the relayer has a fast rebalance route.
    if (!eligibleChains.includes(originChainId) && originQuickRebalance) {
      eligibleChains.push(originChainId);
    }

    // Always add hubChain as a fallback option if inventory management is enabled and origin chain is not a lite chain.
    if (!forceOriginRepayment && !eligibleChains.includes(hubChainId)) {
      eligibleChains.push(hubChainId);
    }
    return eligibleChains;
  }

  /**
   * Returns running balances for l1Tokens on all slow withdrawal chains that are enabled for this l1Token.
   * @param l1Token
   * @returns Dictionary keyed by chain ID of the absolute value of the latest running balance for the l1Token.
   */
  private async _getLatestRunningBalances(
    l1Token: EvmAddress,
    chainsToEvaluate: number[]
  ): Promise<{ [chainId: number]: BigNumber }> {
    const mark = this.profiler.start("getLatestRunningBalances");
    const runningBalances = await getLatestRunningBalances(
      l1Token,
      chainsToEvaluate,
      this.hubPoolClient,
      this.bundleDataApproxClient
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
    l1Token: EvmAddress,
    refundAmountInL1TokenDecimals: BigNumber
  ): { [chainId: number]: BigNumber } {
    const pcts = Object.fromEntries(
      Object.entries(excessRunningBalances).map(([_chainId, excess]) => {
        const chainId = Number(_chainId);
        const target = this.hubPoolClient.configStoreClient.getSpokeTargetBalancesForBlock(
          l1Token.toNative(),
          chainId
        ).target;
        const excessPostRelay = excess.sub(refundAmountInL1TokenDecimals);
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
      refundAmountInL1TokenDecimals,
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
    l1Token: EvmAddress,
    refundAmountInL1TokenDecimals: BigNumber,
    chainsToEvaluate: number[]
  ): Promise<{ [chainId: number]: BigNumber }> {
    if (!isDefined(this.excessRunningBalancePromises[l1Token.toNative()])) {
      // @dev Save this as a promise so that other parallel calls to this function don't make the same call.
      const cacheKey = l1Token.toNative();
      const runningBalancePromise = this._getLatestRunningBalances(l1Token, chainsToEvaluate).catch((error) => {
        if (this.excessRunningBalancePromises[cacheKey] === runningBalancePromise) {
          delete this.excessRunningBalancePromises[cacheKey];
        }
        throw error;
      });
      this.excessRunningBalancePromises[cacheKey] = runningBalancePromise;
    }
    const excessRunningBalances = lodash.cloneDeep(await this.excessRunningBalancePromises[l1Token.toNative()]);
    return this._getExcessRunningBalancePcts(excessRunningBalances, l1Token, refundAmountInL1TokenDecimals);
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
          // Make sure to prioritize shortfall rebalances over ordinary rebalances by pushing them into the array first
          const shortfallRebalances = this._getPossibleShortfallRebalances(l1Token, chainId, l2Token);
          rebalancesRequired.push(...shortfallRebalances);
          const inventoryRebalance = this._getPossibleInventoryRebalances(cumulativeBalance, l1Token, chainId, l2Token);
          if (inventoryRebalance) {
            rebalancesRequired.push(inventoryRebalance);
          }
        });
      });
    }

    return rebalancesRequired;
  }

  _getPossibleInventoryRebalances(
    cumulativeL1TokenBalance: BigNumber,
    l1Token: EvmAddress,
    chainId: number,
    l2Token: Address
  ): Rebalance | undefined {
    const currentAllocPct = this.getCurrentAllocationPct(
      l1Token,
      chainId,
      l2Token,
      false, // Don't ignore pending l1 to l2 amounts so we don't send duplicate rebalances,
      true // Ignore shortfall since we will account for shortfall rebalances in another step.
    );
    const tokenConfig = this.getTokenConfig(l1Token, chainId, l2Token);
    if (!isDefined(tokenConfig)) {
      return;
    }

    const { thresholdPct, targetPct } = tokenConfig;
    if (currentAllocPct.gte(thresholdPct)) {
      return;
    }

    const deltaPct = targetPct.sub(currentAllocPct);
    const amount = deltaPct.mul(cumulativeL1TokenBalance).div(this.scalar);
    const balance = this.tokenClient.getBalance(this.hubPoolClient.chainId, l1Token);
    return {
      chainId,
      l1Token,
      l2Token,
      balance,
      amount,
      isShortfallRebalance: false,
    };
  }

  _getPossibleShortfallRebalances(l1Token: EvmAddress, chainId: number, l2Token: Address): Rebalance[] {
    const { decimals: l1TokenDecimals } = this.getTokenInfo(l1Token, this.hubPoolClient.chainId);
    const { decimals: l2TokenDecimals } = this.getTokenInfo(l2Token, chainId);
    // Order unfilled amounts from largest to smallest to prioritize larger shortfalls.
    const unfilledDepositAmounts = this.tokenClient
      .getUnfilledDepositAmounts(chainId, l2Token)
      .sort(bnComparatorDescending)
      .map((unfilledAmount) => sdkUtils.ConvertDecimals(l2TokenDecimals, l1TokenDecimals)(unfilledAmount));
    let outstandingCrossChainTransferAmount = this.crossChainTransferClient.getOutstandingCrossChainTransferAmount(
      this.relayer,
      chainId,
      l1Token,
      l2Token
    );
    const rebalancesRequired: Rebalance[] = [];
    for (const depositAmount of unfilledDepositAmounts) {
      // If this pending deposit amount is greater than the outstanding cross chain transfer amount,
      // then we need to send a rebalance, so send enough to cover the shortfall when taking into account the
      // outstanding cross chain transfer amount.
      if (depositAmount.gt(outstandingCrossChainTransferAmount)) {
        rebalancesRequired.push({
          chainId,
          l1Token,
          l2Token,
          balance: this.tokenClient.getBalance(this.hubPoolClient.chainId, l1Token),
          amount: depositAmount.sub(outstandingCrossChainTransferAmount),
          isShortfallRebalance: true,
        });
      }
      outstandingCrossChainTransferAmount = max(bnZero, outstandingCrossChainTransferAmount.sub(depositAmount));
    }
    return rebalancesRequired;
  }

  // Trigger a rebalance if the current balance on any L2 chain, including shortfalls, is less than the threshold
  // allocation.
  async rebalanceInventoryIfNeeded(): Promise<void> {
    // Note: these types are just used inside this method, so they are declared in-line.
    type ExecutedRebalance = Rebalance & { hash: string };

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

    const possibleRebalances: Rebalance[] = [];
    const unexecutedRebalances: Rebalance[] = [];
    const executedTransactions: ExecutedRebalance[] = [];

    // Next, evaluate if we have enough tokens on L1 to actually do these rebalances.
    for (const rebalance of rebalancesRequired) {
      const { balance, amount, l1Token, l2Token, chainId } = rebalance;

      // This is the balance left after any assumed rebalances from earlier loop iterations.
      const unallocatedBalance = this.tokenClient.getBalance(this.hubPoolClient.chainId, l1Token);

      // If the amount required in the rebalance is less than the total amount of this token on L1 then we can execute
      // the rebalance to this particular chain. Note that if the sum of all rebalances required exceeds the l1
      // balance then this logic ensures that we only fill the first n number of chains where we can.
      if (toBN(amount).lte(unallocatedBalance)) {
        // As a precautionary step before proceeding, check that the token balance for the token we're about to send
        // hasn't changed on L1. It's possible its changed since we updated the inventory due to one or more of the
        // RPC's returning slowly, leading to concurrent/overlapping instances of the bot running.
        const tokenContract = new Contract(l1Token.toNative(), ERC20.abi, this.hubPoolClient.hubPool.signer);
        const currentBalance = await tokenContract.balanceOf(this.relayer.toNative());

        const balanceChanged = !balance.eq(currentBalance);
        const [message, log] = balanceChanged
          ? ["🚧 Token balance on mainnet changed, skipping rebalance", this.logger.warn]
          : ["Token balance in relayer on mainnet is as expected, sending cross chain transfer", this.logger.debug];
        log({
          at: "InventoryClient",
          message,
          l1Token,
          l2Token,
          l2ChainId: chainId,
          balance,
          currentBalance,
        });

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
    this.log("Considered inventory rebalances", {
      rebalancesRequired,
      possibleRebalances,
    });

    // Finally, execute the rebalances.
    // TODO: The logic below is slow as it waits for each transaction to be included before sending the next one. This
    // should be refactored to enable us to pass an array of transaction objects to the transaction util that then
    // sends each transaction one after the other with incrementing nonce. this will be left for a follow on PR as this
    // is already complex logic and most of the time we'll not be sending batches of rebalance transactions.
    for (const rebalance of possibleRebalances) {
      const { chainId, l1Token, l2Token, amount, isShortfallRebalance } = rebalance;
      // Send a faster transfer if there is an active shortfall on the chain, otherwise use the slower, cheaper,
      // default transfer.
      const optionalParams: TransferTokenParams = {
        fastMode: isShortfallRebalance,
      };

      try {
        const { hash } = await this.sendTokenCrossChain(
          chainId,
          l1Token,
          amount,
          this.simMode,
          l2Token,
          optionalParams
        );
        executedTransactions.push({ ...rebalance, hash });
      } catch (error) {
        this.log(
          "Something errored during inventory rebalance",
          { error, chainId, l1Token, l2Token, amount, optionalParams }, // include all info to help debugging.
          "error"
        );
      }
    }

    // Construct logs on the cross-chain actions executed.
    let mrkdwn = "";

    const groupedRebalances = Object.groupBy(executedTransactions, (txn) => txn.chainId);
    for (const [_chainId, rebalances] of Object.entries(groupedRebalances)) {
      const chainId = Number(_chainId);
      mrkdwn += `*Rebalances sent to ${getNetworkName(chainId)}:*\n`;
      for (const { l1Token, l2Token, amount, hash, chainId, isShortfallRebalance } of rebalances) {
        const tokenInfo = this.getTokenInfo(l2Token, chainId);
        assert(
          isDefined(tokenInfo),
          `InventoryClient::rebalanceInventoryIfNeeded no token info for L2 token ${l2Token} on chain ${chainId}`
        );
        const { symbol, decimals } = tokenInfo;
        const l2TokenFormatter = createFormatFunction(2, 4, false, decimals);
        const l1TokenInfo = this.getTokenInfo(l1Token, this.hubPoolClient.chainId);
        const l1Formatter = createFormatFunction(2, 4, false, l1TokenInfo.decimals);

        const cumulativeBalance = this.getCumulativeBalance(l1Token);
        const tokenConfig = this.getTokenConfig(l1Token, chainId, l2Token);
        const { thresholdPct, targetPct } = tokenConfig;
        if (isShortfallRebalance) {
          const totalShortfall = this.tokenClient.getShortfallTotalRequirement(chainId, l2Token);
          mrkdwn +=
            `- ${l1Formatter(amount)} ${symbol} rebalanced to cover total chain shortfall of ` +
            `${l2TokenFormatter(totalShortfall)} ${symbol} `;
        } else {
          mrkdwn +=
            ` - ${l1Formatter(amount)} ${symbol} rebalanced. This meets target allocation of ` +
            `${this.formatWei(targetPct.mul(100))}% (trigger of ` +
            `${this.formatWei(thresholdPct.mul(100))}%) of the total ` +
            `${l1Formatter(cumulativeBalance)} ${symbol} over all chains (ignoring hubpool repayments).`;
        }
        mrkdwn += ` tx: ${blockExplorerLink(hash, this.hubPoolClient.chainId)}\n`;
      }
    }

    const groupedUnexecutedRebalances = Object.groupBy(unexecutedRebalances, (txn) => txn.chainId);
    for (const [_chainId, rebalances] of Object.entries(groupedUnexecutedRebalances)) {
      const chainId = Number(_chainId);
      mrkdwn += `*Insufficient amount to rebalance to ${getNetworkName(chainId)}:*\n`;
      for (const { l1Token, l2Token, balance, amount } of rebalances) {
        const tokenInfo = this.getTokenInfo(l2Token, chainId);
        if (!tokenInfo) {
          throw new Error(
            `InventoryClient::rebalanceInventoryIfNeeded no token info for L2 token ${l2Token} on chain ${chainId}`
          );
        }
        const l1TokenInfo = this.getTokenInfo(l1Token, this.hubPoolClient.chainId);
        const l1Formatter = createFormatFunction(2, 4, false, l1TokenInfo.decimals);

        const { symbol, decimals } = tokenInfo;
        const l2TokenFormatter = createFormatFunction(2, 4, false, decimals);
        const distributionPct = tokenDistributionPerL1Token[l1Token.toNative()][chainId][l2Token.toNative()].mul(100);
        const cumulativeBalance = this.getCumulativeBalance(l1Token);
        mrkdwn +=
          `- ${symbol} transfer blocked. Required to send ` +
          `${l1Formatter(amount)} but relayer has ` +
          `${l1Formatter(balance)} on L1. There is currently ` +
          `${l1Formatter(this.getBalanceOnChain(chainId, l1Token, l2Token))} ${symbol} on ` +
          `${getNetworkName(chainId)} which is ` +
          `${this.formatWei(distributionPct)}% of the total ` +
          `${l1Formatter(cumulativeBalance)} ${symbol}.` +
          " This chain's pending L1->L2 transfer amount is " +
          `${l1Formatter(
            this.crossChainTransferClient.getOutstandingCrossChainTransferAmount(
              this.relayer,
              chainId,
              l1Token,
              l2Token
            )
          )}.` +
          ` This chain has a shortfall of ${l2TokenFormatter(
            this.tokenClient.getShortfallTotalRequirement(chainId, l2Token)
          )} ${symbol}.\n`;
      }
    }

    if (mrkdwn) {
      this.log("Executed Inventory rebalances 📒", { mrkdwn }, "info");
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
      const l1Weth = EvmAddress.from(TOKEN_SYMBOLS_MAP.WETH.addresses[this.hubPoolClient.chainId]);
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
          .map(async (chainInfo) => {
            const spokePoolClient = this.tokenClient.spokePoolManager.getClient(chainInfo.chainId);
            assert(isDefined(spokePoolClient), `SpokePoolClient not found for chainId ${chainInfo.chainId}`);
            assert(isEVMSpokePoolClient(spokePoolClient));
            return {
              ...chainInfo,
              balance: await spokePoolClient.spokePool.provider.getBalance(this.relayer.toNative()),
            };
          })
      );

      this.log("Checking WETH unwrap thresholds for chains with thresholds set", { chains });

      chains.forEach((chainInfo) => {
        const { chainId, weth, unwrapWethThreshold, unwrapWethTarget, balance } = chainInfo;
        const l2WethBalance = this.tokenClient.getBalance(chainId, toAddressType(weth, chainId));

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
        this.tokenClient.decrementLocalBalance(chainId, toAddressType(weth, chainId), amount);
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
          `${formatter(this.tokenClient.getBalance(chainId, toAddressType(weth, chainId)).toString())} WETH balance.\n`;
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

  async withdrawExcessBalances(): Promise<void> {
    if (!this.isInventoryManagementEnabled()) {
      return;
    }

    const chainIds = this.getEnabledL2Chains();
    type L2Withdrawal = { l2Token: Address; amountToWithdraw: BigNumber };
    const withdrawalsRequired: { [chainId: number]: L2Withdrawal[] } = {};
    const chainMrkdwns: { [chainId: number]: string } = {};

    await sdkUtils.forEachAsync(this.getL1Tokens(), async (l1Token) => {
      const l1TokenInfo = this.getTokenInfo(l1Token, this.hubPoolClient.chainId);
      const formatter = createFormatFunction(2, 4, false, l1TokenInfo.decimals);

      // We do not currently count any outstanding L2->L1 pending withdrawal balance in the cumulative balance
      // because it can take so long for these withdrawals to finalize (usually >1 day and up to 7 days). Unlike the
      // L1->L2 pending deposit balances which will finalize in <1 hour in most cases. For allocation % calculations,
      // these pending withdrawals are therefore ignored.
      const cumulativeBalance = this.getCumulativeBalance(l1Token);
      if (cumulativeBalance.eq(bnZero)) {
        return;
      }
      await sdkUtils.forEachAsync(chainIds, async (chainId) => {
        if (chainId === this.hubPoolClient.chainId || !this._l1TokenEnabledForChain(l1Token, chainId)) {
          return;
        }
        let mrkdwn = `*Withdrawals from ${getNetworkName(chainId)}:*\n`;

        const l2Tokens = this.getRemoteTokensForL1Token(l1Token, chainId);
        await sdkUtils.forEachAsync(l2Tokens, async (l2Token) => {
          const { decimals: l2TokenDecimals } = this.getTokenInfo(l2Token, chainId);
          const l2TokenFormatter = createFormatFunction(2, 4, false, l2TokenDecimals);
          const l2BalanceFromL1Decimals = sdkUtils.ConvertDecimals(l1TokenInfo.decimals, l2TokenDecimals);
          const tokenConfig = this.getTokenConfig(l1Token, chainId, l2Token);
          if (!isDefined(tokenConfig)) {
            return;
          }
          // When l2 token balance exceeds threshold, withdraw (balance - target) to hub pool.
          const { targetOverageBuffer, targetPct, withdrawExcessPeriod } = tokenConfig;

          // Excess withdrawals are activated only for chains where the withdrawExcessPeriod variable is set.
          if (!isDefined(withdrawExcessPeriod)) {
            return;
          }

          const adapter = this.adapterManager.adapters[chainId];
          if (!adapter.isSupportedL2Bridge(l1Token)) {
            this.logger.warn({
              at: "InventoryClient#withdrawExcessBalances",
              message: `No L2 bridge configured for ${getNetworkName(chainId)} for token ${l1Token}`,
            });
            return;
          }

          // Ignore L1->L2 pending amounts for the current allocation % calculation because we never want to cancel
          // out a deposit from L1 to L2 by immediately withdrawing it. Don't ignore shortfalls.
          const currentAllocPct = this.getCurrentAllocationPct(l1Token, chainId, l2Token, true, false);

          // We apply a discount on the effective target % because the repayment chain choice
          // algorithm should never allow the inventory to get above the target pct * target overage buffer.
          // Withdraw excess when current allocation % is within a small % of the target percentage multiplied
          // by the target overage buffer.
          const discountToTargetOverageBuffer = toBNWei("0.95");
          const targetPctMultiplier = targetOverageBuffer.mul(discountToTargetOverageBuffer).div(this.scalar);
          assert(
            targetPctMultiplier.gte(toBNWei("1")),
            `Target overage buffer multiplied by discount must be >= 1, got ${targetPctMultiplier.toString()}`
          );
          const excessWithdrawThresholdPct = targetPct.mul(targetPctMultiplier).div(this.scalar);

          const shouldWithdrawExcess = currentAllocPct.gte(excessWithdrawThresholdPct);
          const withdrawPct = currentAllocPct.sub(targetPct);
          const cumulativeBalanceInL2TokenDecimals = l2BalanceFromL1Decimals(cumulativeBalance);
          const desiredWithdrawalAmount = cumulativeBalanceInL2TokenDecimals.mul(withdrawPct).div(this.scalar);

          this.log(
            `Evaluated withdrawing excess balance on ${getNetworkName(chainId)} for token ${l1TokenInfo.symbol}: ${
              shouldWithdrawExcess ? "HAS EXCESS ✅" : "NO EXCESS ❌"
            }`,
            {
              l1Token,
              l2Token,
              cumulativeBalance: formatter(cumulativeBalance),
              currentAllocPct: formatUnits(currentAllocPct, 18),
              excessWithdrawThresholdPct: formatUnits(excessWithdrawThresholdPct, 18),
              targetPct: formatUnits(targetPct, 18),
              withdrawalParams: shouldWithdrawExcess
                ? {
                    withdrawPct: formatUnits(withdrawPct, 18),
                    desiredWithdrawalAmount: l2TokenFormatter(desiredWithdrawalAmount),
                  }
                : undefined,
            }
          );
          if (!shouldWithdrawExcess) {
            return;
          }
          // Check to make sure the total pending volume withdrawn over the last
          // maxL2WithdrawalPeriodSeconds does not exceed the maxL2WithdrawalVolume.
          const maxL2WithdrawalVolume = excessWithdrawThresholdPct
            .sub(targetPct)
            .mul(cumulativeBalanceInL2TokenDecimals)
            .div(this.scalar);
          // Note: getL2PendingWithdrawalAmount() returns a value in L2 token decimals so we can compare it with
          // maxL2WithdrawalVolume.
          const pendingWithdrawalAmount = await this.adapterManager.getL2PendingWithdrawalAmountWithLookbackPeriod(
            withdrawExcessPeriod,
            chainId,
            this.relayer,
            l2Token
          );
          // If this withdrawal would push the volume over the limit, allow it because the
          // a subsequent withdrawal would be blocked. In other words, the maximum withdrawal volume
          // would still behave as a rate-limit but with some overage allowed.
          const withdrawalVolumeOverCap = pendingWithdrawalAmount.gte(maxL2WithdrawalVolume);
          this.log(
            `Total withdrawal volume for the last ${withdrawExcessPeriod} seconds is ${
              withdrawalVolumeOverCap ? "OVER" : "UNDER"
            } the limit of ${l2TokenFormatter(maxL2WithdrawalVolume)} for ${l1TokenInfo.symbol} on ${getNetworkName(
              chainId
            )}, ${withdrawalVolumeOverCap ? "cannot" : "proceeding to"} withdraw ${l2TokenFormatter(
              desiredWithdrawalAmount
            )}.`,
            {
              excessWithdrawThresholdPct: formatUnits(excessWithdrawThresholdPct, 18),
              targetPct: formatUnits(targetPct, 18),
              maximumWithdrawalPct: formatUnits(excessWithdrawThresholdPct.sub(targetPct), 18),
              maximumWithdrawalAmount: l2TokenFormatter(maxL2WithdrawalVolume),
              pendingWithdrawalAmount: l2TokenFormatter(pendingWithdrawalAmount),
            }
          );
          if (pendingWithdrawalAmount.gte(maxL2WithdrawalVolume)) {
            return;
          }
          withdrawalsRequired[chainId] ??= [];
          withdrawalsRequired[chainId].push({
            l2Token,
            amountToWithdraw: desiredWithdrawalAmount,
          });

          mrkdwn +=
            ` - ${l2TokenFormatter(desiredWithdrawalAmount)} ${
              l1TokenInfo.symbol
            } withdrawn. This meets target allocation of ` +
            `${this.formatWei(targetPct.mul(100).toString())}% (trigger of ` +
            `${this.formatWei(excessWithdrawThresholdPct.mul(100).toString())}%) of the total ` +
            `${formatter(cumulativeBalance.toString())} ${
              l1TokenInfo.symbol
            } over all chains (ignoring hubpool repayments). This chain has a shortfall of ` +
            `${l2TokenFormatter(this.tokenClient.getShortfallTotalRequirement(chainId, l2Token).toString())} ${
              l1TokenInfo.symbol
            }.` +
            ` This chain's current allocation is ${this.formatWei(currentAllocPct.mul(100).toString())}%\n`;
        });

        if (withdrawalsRequired[chainId] && withdrawalsRequired[chainId].length > 0) {
          chainMrkdwns[chainId] = mrkdwn;
        }
      });
    });

    if (Object.keys(withdrawalsRequired).length === 0) {
      this.log("No excess balances to withdraw");
      return;
    } else {
      this.log("Excess balances to withdraw", {
        withdrawalsRequired,
      });
    }

    // Now, go through each chain and submit transactions. We cannot batch them unfortunately since the bridges
    // pull tokens from the msg.sender.
    const txnReceipts: { [chainId: number]: string[] } = {};
    await sdkUtils.forEachAsync(Object.keys(withdrawalsRequired), async (_chainId) => {
      const chainId = Number(_chainId);
      txnReceipts[chainId] = [];
      await sdkUtils.forEachAsync(withdrawalsRequired[chainId], async (withdrawal) => {
        const txnRef = await this.adapterManager.withdrawTokenFromL2(
          this.relayer,
          chainId,
          withdrawal.l2Token,
          withdrawal.amountToWithdraw,
          this.simMode
        );
        txnReceipts[chainId].push(...txnRef);
      });
    });
    Object.keys(txnReceipts).forEach((_chainId) => {
      const chainId = Number(_chainId);
      this.logger.debug({
        at: "InventoryClient",
        message: `L2->L1 withdrawals on ${getNetworkName(chainId)} submitted`,
        chainId,
        withdrawalsRequired: withdrawalsRequired[chainId].map((withdrawal: L2Withdrawal) => {
          const l2TokenInfo = this.getTokenInfo(withdrawal.l2Token, chainId);

          const formatter = createFormatFunction(2, 4, false, l2TokenInfo.decimals);
          return {
            l2Token: l2TokenInfo.symbol,
            amountToWithdraw: formatter(withdrawal.amountToWithdraw.toString()),
          };
        }),
        txnReceipt: txnReceipts[chainId],
      });
      this.log("Executed excess L2 inventory withdrawal 📒", { mrkdwn: chainMrkdwns[Number(chainId)] }, "info");
    });
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
      const tokenInfo = this.getTokenInfo(EvmAddress.from(l1Token), this.hubPoolClient.chainId);
      if (tokenInfo === undefined) {
        throw new Error(
          `InventoryClient::constructConsideringRebalanceDebugLog info not found for L1 token ${l1Token}`
        );
      }
      const { symbol, decimals } = tokenInfo;
      const formatter = createFormatFunction(2, 4, false, decimals);
      cumulativeBalances[symbol] = formatter(this.getCumulativeBalance(EvmAddress.from(l1Token)).toString());
      logData[symbol] ??= {};

      Object.keys(distributionForToken).forEach((_chainId) => {
        const chainId = Number(_chainId);
        logData[symbol][chainId] ??= {};

        Object.entries(distributionForToken[chainId]).forEach(([_l2Token, amount]) => {
          const l2Token = toAddressType(_l2Token, chainId);
          const { decimals: l2TokenDecimals } = this.getTokenInfo(l2Token, chainId);
          const l2Formatter = createFormatFunction(2, 4, false, l2TokenDecimals);
          const l1TokenAddr = EvmAddress.from(l1Token);
          const balanceOnChain = this.getBalanceOnChain(chainId, l1TokenAddr, l2Token);
          const transfers = this.crossChainTransferClient.getOutstandingCrossChainTransferAmount(
            this.relayer,
            chainId,
            l1TokenAddr,
            l2Token
          );
          const actualBalanceOnChain = this.tokenClient.getBalance(chainId, l2Token);
          logData[symbol][chainId][l2Token.toNative()] = {
            actualBalanceOnChain: l2Formatter(actualBalanceOnChain.toString()),
            virtualBalanceOnChain: formatter(balanceOnChain.toString()),
            outstandingTransfers: formatter(transfers.toString()),
            tokenShortFalls: l2Formatter(this.tokenClient.getShortfallTotalRequirement(chainId, l2Token).toString()),
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
    l1Token: EvmAddress,
    amount: BigNumber,
    simMode = false,
    l2Token?: Address,
    optionalParams?: TransferTokenParams
  ): Promise<TransactionResponse> {
    return this.adapterManager.sendTokenCrossChain(
      this.relayer,
      Number(chainId),
      l1Token,
      amount,
      simMode,
      l2Token,
      optionalParams
    );
  }

  _unwrapWeth(chainId: number, _l2Weth: string, amount: BigNumber): Promise<TransactionResponse> {
    const spokePoolClient = this.tokenClient.spokePoolManager.getClient(chainId);
    assert(isDefined(spokePoolClient), `SpokePoolClient not found for chainId ${chainId}`);
    assert(isEVMSpokePoolClient(spokePoolClient));
    const l2Signer = spokePoolClient.spokePool.signer;
    const l2Weth = new Contract(_l2Weth, WETH_ABI, l2Signer);
    this.log("Unwrapping WETH", { amount: amount.toString() });
    return submitTransaction(
      {
        contract: l2Weth,
        method: "withdraw",
        args: [amount],
        chainId,
      },
      this.transactionClient
    );
  }

  async setTokenApprovals(): Promise<void> {
    if (!this.isInventoryManagementEnabled()) {
      return;
    }
    const l1Tokens = this.getL1Tokens();
    this.log("Checking token approvals", { l1Tokens: l1Tokens.map((token) => token.toEvmAddress()) });

    await this.adapterManager.setL1TokenApprovals(l1Tokens);
  }

  async wrapL2EthIfAboveThreshold(): Promise<void> {
    // If inventoryConfig is defined, there should be a default wrapEtherTarget and wrapEtherThreshold
    // set by RelayerConfig.ts
    if (!this?.inventoryConfig?.wrapEtherThreshold || !this?.inventoryConfig?.wrapEtherTarget) {
      return;
    }
    this.log("Checking ETH->WETH Wrap status");
    await this.adapterManager.wrapNativeTokenIfAboveThreshold(this.inventoryConfig, this.simMode);
  }

  async update(chainIds?: number[]): Promise<void> {
    if (!this.isInventoryManagementEnabled()) {
      return;
    }

    await this.crossChainTransferClient.update(this.getL1Tokens(), chainIds);

    await forEachAsync(this.getL1Tokens(), async (l1Token) => {
      this.pendingL2Withdrawals[l1Token.toNative()] = {};
      const pendingWithdrawalBalances =
        await this.crossChainTransferClient.adapterManager.getTotalPendingWithdrawalAmount(
          this.getEnabledChains().filter((chainId) => chainId !== this.hubPoolClient.chainId),
          this.relayer,
          l1Token
        );
      Object.keys(pendingWithdrawalBalances).forEach((chainId) => {
        if (pendingWithdrawalBalances[Number(chainId)].gt(bnZero)) {
          this.pendingL2Withdrawals[l1Token.toNative()][Number(chainId)] = pendingWithdrawalBalances[Number(chainId)];
        }
      });
    });
    this.logger.debug({
      at: "InventoryClient#update",
      message: "Updated pending L2->L1 withdrawals",
      pendingL2Withdrawals: this.pendingL2Withdrawals,
    });

    this.pendingRebalances = await this.rebalancerClient.getPendingRebalances(this.relayer);
    if (Object.keys(this.pendingRebalances).length > 0) {
      this.logger.debug({
        at: "InventoryClient#update",
        message: "Updated RebalancerClient pending rebalances",
        pendingRebalances: Object.entries(this.pendingRebalances).map(([chainId, tokens]) => ({
          [chainId]: Object.fromEntries(Object.entries(tokens).map(([token, amount]) => [token, amount.toString()])),
        })),
      });
    }

    if (isDefined(this.binanceClient)) {
      await this.binanceClient.refresh();
      await this.updateTokenPrices();
    }
  }

  // Strict-fail: any error clears the cache.
  private async updateTokenPrices(): Promise<void> {
    this.l1TokenPricesUsd.clear();
    if (!isDefined(this.priceClient)) {
      return;
    }
    const binanceRouteTokens = this.getL1Tokens().filter((l1Token) =>
      this.getEnabledChains().some((chainId) => hasBinanceRoute(chainId, l1Token))
    );
    if (binanceRouteTokens.length === 0) {
      return;
    }
    try {
      const prices = await this.priceClient.getPricesByAddress(
        binanceRouteTokens.map((l1Token) => l1Token.toNative()),
        "usd"
      );
      prices.forEach(({ address, price }) => {
        if (price > 0) {
          this.l1TokenPricesUsd.set(address, toBNWei(price.toFixed(18)));
        }
      });
    } catch (err) {
      this.logger.warn({
        at: "InventoryClient#updateTokenPrices",
        message: "Failed to refresh token prices; downstream capacity checks disabled for this cycle",
        error: err instanceof Error ? err.message : String(err),
      });
    }
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

  _l1TokenEnabledForChain(l1Token: EvmAddress, chainId: number): boolean {
    const tokenConfig = this.inventoryConfig?.tokenConfig?.[l1Token.toNative()];
    if (!isDefined(tokenConfig)) {
      return false;
    }

    // If tokenConfig directly references chainId, token is enabled.
    if (!isAliasConfig(tokenConfig) && isDefined(tokenConfig[chainId])) {
      return true;
    }

    // If any of the mapped symbols reference chainId, token is enabled.
    return (
      isAliasConfig(tokenConfig) && Object.keys(tokenConfig).some((symbol) => isDefined(tokenConfig[symbol][chainId]))
    );
  }

  /**
   * @notice Return possible repayment chains for L1 token that have "slow withdrawals" from L2 to L1, so
   * taking repayment on these chains would be done to reduce HubPool utilization and keep funds out of the
   * slow withdrawal canonical bridges. Explicitly skip chains with fast rebalancing options because it doesn't
   * help with utilisation issues.
   * @param l1Token
   * @returns list of chains for l1Token that have a token config enabled and have pool rebalance routes set.
   */
  getSlowWithdrawalRepaymentChains(l1Token: EvmAddress): number[] {
    return SLOW_WITHDRAWAL_CHAINS.filter((repaymentChainId) => {
      if (
        !this._l1TokenEnabledForChain(l1Token, repaymentChainId) ||
        !this.hubPoolClient.l2TokenEnabledForL1Token(l1Token, repaymentChainId)
      ) {
        return false;
      }
      const repaymentToken = this.hubPoolClient.getL2TokenForL1TokenAtBlock(l1Token, repaymentChainId);
      return !this.isQuicklyRebalanced(repaymentChainId, repaymentToken);
    });
  }

  // True for unmetered fast-rebalance routes (CCTP, OFT, hub). Binance is excluded — it's quota-gated.
  private isUnmeteredFastRebalance(repaymentChainId: number, repaymentToken: Address): boolean {
    const { chainId: hubChainId } = this.hubPoolClient;
    const originChainIsCctpEnabled =
      sdkUtils.chainIsCCTPEnabled(repaymentChainId) &&
      compareAddressesSimple(TOKEN_SYMBOLS_MAP.USDC.addresses[repaymentChainId], repaymentToken.toNative());
    const originChainIsOFTEnabled =
      sdkUtils.chainIsOFTEnabled(repaymentChainId) &&
      compareAddressesSimple(TOKEN_SYMBOLS_MAP.USDT.addresses[repaymentChainId], repaymentToken.toNative()) &&
      repaymentChainId !== CHAIN_IDs.HYPEREVM; // OFT withdrawals from HyperEVM take ~12 hours.
    // Repayments on Mainnet can be quickly rebalanced via canonical bridges out of L1.
    return originChainIsCctpEnabled || originChainIsOFTEnabled || repaymentChainId === hubChainId;
  }

  /**
   * @notice Returns true if after filling this deposit, the repayment can be quickly rebalanced to a different chain.
   * @dev This function can be used by the InventoryClient and Relayer to help determine whether a deposit should
   * be filled or ignored given current inventory allocation levels.
   */
  private isQuicklyRebalanced(repaymentChainId: number, repaymentToken: Address): boolean {
    if (this.isUnmeteredFastRebalance(repaymentChainId, repaymentToken)) {
      return true;
    }

    // If Binance offers a withdrawal route for this (chain, token), inventory repaid on this chain can be
    // moved off via Binance in place of the canonical slow-withdrawal bridge. This naturally covers BSC
    // (whose canonical L2 bridge is Binance for every token) as well as per-token Binance routes on
    // slow-withdrawal chains like Arbitrum, Optimism, and Base.
    const { chainId: hubChainId } = this.hubPoolClient;
    try {
      const l1Token = getInventoryEquivalentL1TokenAddress(repaymentToken, repaymentChainId, hubChainId);
      return hasBinanceRoute(repaymentChainId, l1Token);
    } catch {
      return false;
    }
  }

  // True if origin repayment can be drained quickly for this fill size. Binance requires a wired
  // client and a cached USD price; missing either fails closed.
  private canFastRebalanceFill(
    repaymentChainId: number,
    repaymentToken: Address,
    l1Token: EvmAddress,
    inputAmountInL1TokenDecimals: BigNumber,
    l1TokenDecimals: number
  ): boolean {
    if (this.isUnmeteredFastRebalance(repaymentChainId, repaymentToken)) {
      return true;
    }
    if (!isDefined(this.binanceClient)) {
      return false;
    }
    const priceUsd = this.l1TokenPricesUsd.get(l1Token.toNative());
    if (!isDefined(priceUsd)) {
      return false;
    }
    const fillUsd = inputAmountInL1TokenDecimals.mul(priceUsd).div(BigNumber.from(10).pow(l1TokenDecimals));
    const bufferedUsd = fillUsd.mul(this.cexRebalanceBuffer).div(fixedPointAdjustment);
    return this.binanceClient.canWithdraw(bufferedUsd, repaymentChainId, l1Token);
  }

  log(message: string, data?: AnyObject, level: DefaultLogLevels = "debug"): void {
    if (this.logger) {
      this.logger[level]({ at: "InventoryClient", message, ...data });
    }
  }
}

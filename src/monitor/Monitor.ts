import { BundleDataApproxClient } from "../clients";
import { EXPECTED_L1_TO_L2_MESSAGE_TIME } from "../common";
import {
  BalanceType,
  BundleAction,
  DepositWithBlock,
  FillStatus,
  FillWithBlock,
  L1Token,
  RelayerBalanceReport,
  RelayerBalanceTable,
  TokenTransfer,
  TokenInfo,
  SwapFlowInitialized,
} from "../interfaces";
import {
  BigNumber,
  bnZero,
  bnUint32Max,
  Contract,
  convertFromWei,
  createFormatFunction,
  ERC20,
  blockExplorerLink,
  blockExplorerLinks,
  formatUnits,
  getNativeTokenAddressForChain,
  getNativeTokenSymbol,
  getNetworkName,
  getUnfilledDeposits,
  mapAsync,
  getEndBlockBuffers,
  parseUnits,
  providers,
  toBN,
  toBNWei,
  winston,
  TOKEN_SYMBOLS_MAP,
  CHAIN_IDs,
  isDefined,
  resolveTokenDecimals,
  sortEventsDescending,
  getWidestPossibleExpectedBlockRange,
  utils,
  _buildPoolRebalanceRoot,
  getRemoteTokenForL1Token,
  getTokenInfo,
  ConvertDecimals,
  getL1TokenAddress,
  isEVMSpokePoolClient,
  isSVMSpokePoolClient,
  toAddressType,
  Address,
  EvmAddress,
  assert,
  getBinanceApiClient,
  getBinanceWithdrawalLimits,
  chainIsEvm,
  getSolanaTokenBalance,
  getFillStatusPda,
  getKitKeypairFromEvmSigner,
  getRelayDataFromFill,
  sortEventsAscending,
} from "../utils";
import { MonitorClients, updateMonitorClients } from "./MonitorClientHelper";
import { MonitorConfig, L2OnlyToken } from "./MonitorConfig";
import { getImpliedBundleBlockRanges } from "../dataworker/DataworkerUtils";
import { PUBLIC_NETWORKS, TOKEN_EQUIVALENCE_REMAPPING } from "@across-protocol/constants";
import { utils as sdkUtils, arch } from "@across-protocol/sdk";
import {
  address,
  fetchEncodedAccount,
  getBase64EncodedWireTransaction,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { HyperliquidExecutor } from "../hyperliquid/HyperliquidExecutor";
import { HyperliquidExecutorConfig } from "../hyperliquid/HyperliquidExecutorConfig";

// 60 minutes, which is the length of the challenge window, so if a rebalance takes longer than this to finalize,
// then its finalizing after the subsequent challenge period has started, which is sub-optimal.
export const REBALANCE_FINALIZE_GRACE_PERIOD = Number(process.env.REBALANCE_FINALIZE_GRACE_PERIOD ?? 60 * 60);

// bundle frequency.
export const ALL_CHAINS_NAME = "All chains";
const ALL_BALANCE_TYPES = [BalanceType.CURRENT, BalanceType.PENDING, BalanceType.PENDING_TRANSFERS, BalanceType.TOTAL];

type BalanceRequest = { chainId: number; token: Address; account: Address };

export class Monitor {
  // Block range to search is only defined on calling update().
  private hubPoolStartingBlock: number | undefined = undefined;
  private hubPoolEndingBlock: number | undefined = undefined;
  private spokePoolsBlocks: Record<number, { startingBlock: number | undefined; endingBlock: number | undefined }> = {};
  private balanceCache: { [chainId: number]: { [token: string]: { [account: string]: BigNumber } } } = {};
  private decimals: { [chainId: number]: { [token: string]: number } } = {};
  private additionalL1Tokens: L1Token[] = [];
  private l2OnlyTokens: L2OnlyToken[] = [];
  // Chains for each spoke pool client.
  public monitorChains: number[];
  // Chains that we care about inventory manager activity on, so doesn't include Ethereum which doesn't
  // have an inventory manager adapter.
  public crossChainAdapterSupportedChains: number[];
  private bundleDataApproxClient: BundleDataApproxClient;
  private l1Tokens: L1Token[];

  public constructor(
    readonly logger: winston.Logger,
    readonly monitorConfig: MonitorConfig,
    readonly clients: MonitorClients
  ) {
    this.crossChainAdapterSupportedChains = clients.crossChainTransferClient.adapterManager.supportedChains();
    this.monitorChains = Object.values(clients.spokePoolClients).map(({ chainId }) => chainId);
    for (const chainId of this.monitorChains) {
      this.spokePoolsBlocks[chainId] = { startingBlock: undefined, endingBlock: undefined };
    }
    logger.debug({
      at: "Monitor#constructor",
      message: "Initialized monitor",
      monitorChains: this.monitorChains,
      crossChainAdapterSupportedChains: this.crossChainAdapterSupportedChains,
    });
    this.additionalL1Tokens = monitorConfig.additionalL1NonLpTokens.map((l1Token) => {
      const l1TokenInfo = getTokenInfo(EvmAddress.from(l1Token), this.clients.hubPoolClient.chainId);
      assert(l1TokenInfo.address.isEVM());
      return {
        ...l1TokenInfo,
        address: l1TokenInfo.address,
      };
    });
    this.l2OnlyTokens = monitorConfig.l2OnlyTokens;
    this.l1Tokens = this.clients.hubPoolClient.getL1Tokens();
    this.bundleDataApproxClient = new BundleDataApproxClient(
      this.clients.spokePoolClients,
      this.clients.hubPoolClient,
      this.monitorChains,
      [...this.l1Tokens, ...this.additionalL1Tokens].map(({ address }) => address),
      this.logger
    );
  }

  public async update(): Promise<void> {
    // Clear balance cache at the start of each update.
    // Note: decimals don't need to be cleared because they shouldn't ever change.
    this.balanceCache = {};
    await updateMonitorClients(this.clients);
    await this.computeHubPoolBlocks();
    await this.computeSpokePoolsBlocks();
    // We should initialize the bundle data approx client here because it depends on the spoke pool clients, and we
    // should do it every time the spoke pool clients are updated.
    this.bundleDataApproxClient.initialize();

    const searchConfigs = Object.fromEntries(
      Object.entries(this.spokePoolsBlocks).map(([chainId, config]) => [
        chainId,
        {
          from: config.startingBlock,
          to: config.endingBlock,
          maxLookBack: 0,
        },
      ])
    );
    const tokensPerChain = Object.fromEntries(
      this.monitorChains.filter(chainIsEvm).map((chainId) => {
        const l2Tokens = this.l1Tokens
          .map((l1Token) => this.getRemoteTokenForL1Token(l1Token.address, chainId))
          .filter(isDefined);
        return [chainId, l2Tokens];
      })
    );
    await this.clients.tokenTransferClient.update(searchConfigs, tokensPerChain);
  }

  async checkUtilization(): Promise<void> {
    this.logger.debug({ at: "Monitor#checkUtilization", message: "Checking for pool utilization ratio" });
    const l1TokenUtilizations = await Promise.all(
      this.l1Tokens.map(async (l1Token) => {
        const utilization = await this.clients.hubPoolClient.getCurrentPoolUtilization(l1Token.address);
        return {
          l1Token: l1Token.address,
          chainId: this.monitorConfig.hubPoolChainId,
          poolCollateralSymbol: l1Token.symbol,
          utilization: toBN(utilization.toString()),
        };
      })
    );
    // Send notification if pool utilization is above configured threshold.
    for (const l1TokenUtilization of l1TokenUtilizations) {
      if (l1TokenUtilization.utilization.gt(toBN(this.monitorConfig.utilizationThreshold).mul(toBNWei("0.01")))) {
        const utilizationString = l1TokenUtilization.utilization.mul(100).toString();
        const mrkdwn = `${l1TokenUtilization.poolCollateralSymbol} pool token at \
          ${blockExplorerLink(l1TokenUtilization.l1Token.toEvmAddress(), l1TokenUtilization.chainId)} on \
          ${getNetworkName(l1TokenUtilization.chainId)} is at \
          ${createFormatFunction(0, 2)(utilizationString)}% utilization!`;
        this.logger.debug({ at: "Monitor#checkUtilization", message: "High pool utilization warning 🏊", mrkdwn });
      }
    }
  }

  async checkUnknownRootBundleCallers(): Promise<void> {
    this.logger.debug({ at: "Monitor#RootBundleCallers", message: "Checking for unknown root bundle callers" });

    const proposedBundles = this.clients.hubPoolClient.getProposedRootBundlesInBlockRange(
      this.hubPoolStartingBlock,
      this.hubPoolEndingBlock
    );
    const disputedBundles = this.clients.hubPoolClient.getDisputedRootBundlesInBlockRange(
      this.hubPoolStartingBlock,
      this.hubPoolEndingBlock
    );

    for (const event of proposedBundles) {
      this.notifyIfUnknownCaller(event.proposer.toEvmAddress(), BundleAction.PROPOSED, event.txnRef);
    }
    for (const event of disputedBundles) {
      this.notifyIfUnknownCaller(event.disputer, BundleAction.DISPUTED, event.txnRef);
    }
  }

  async reportInvalidFills(): Promise<void> {
    const invalidFills = await sdkUtils.findInvalidFills(this.clients.spokePoolClients);

    const invalidFillsByChainId: Record<string, number> = {};
    invalidFills.forEach((invalidFill) => {
      const destinationChainName = getNetworkName(invalidFill.fill.destinationChainId);
      invalidFillsByChainId[destinationChainName] = (invalidFillsByChainId[destinationChainName] ?? 0) + 1;
      const destinationChainId = invalidFill.fill.destinationChainId;
      const outputToken = invalidFill.fill.outputToken;
      let tokenInfo: TokenInfo;

      try {
        tokenInfo = this.clients.hubPoolClient.getTokenInfoForAddress(outputToken, destinationChainId);
      } catch {
        tokenInfo = { symbol: "UNKNOWN TOKEN", decimals: 18, address: outputToken };
      }

      const formatterFunction = createFormatFunction(2, 4, false, tokenInfo.decimals);
      const formattedOutputAmount = formatterFunction(invalidFill.fill.outputAmount.toString());

      const message =
        `Invalid fill detected for ${getNetworkName(invalidFill.fill.originChainId)} deposit. ` +
        `Output amount: ${formattedOutputAmount} ${tokenInfo.symbol}`;

      const deposit = invalidFill.deposit
        ? {
            txnRef: invalidFill.deposit.txnRef,
            inputToken: invalidFill.deposit.inputToken.toNative(),
            depositor: invalidFill.deposit.depositor.toNative(),
          }
        : undefined;

      this.logger.warn({
        at: "Monitor::reportInvalidFills",
        message,
        destinationChainId,
        outputToken: invalidFill.fill.outputToken.toNative(),
        relayer: invalidFill.fill.relayer.toNative(),
        blockExplorerLink: blockExplorerLink(invalidFill.fill.txnRef, destinationChainId),
        reason: invalidFill.reason,
        deposit,
        notificationPath: "across-invalid-fills",
      });
    });

    if (Object.keys(invalidFillsByChainId).length > 0) {
      this.logger.info({
        at: "Monitor::invalidFillsByChain",
        message: "Invalid fills by chain",
        invalidFillsByChainId,
        notificationPath: "across-invalid-fills",
      });
    }
  }

  async reportUnfilledDeposits(): Promise<void> {
    const { hubPoolClient, spokePoolClients } = this.clients;
    const unfilledDeposits: Record<number, DepositWithBlock[]> = Object.fromEntries(
      await mapAsync(Object.values(spokePoolClients), async ({ chainId: destinationChainId }) => {
        const deposits = getUnfilledDeposits(spokePoolClients[destinationChainId], spokePoolClients, hubPoolClient).map(
          ({ deposit, invalidFills: invalid }) => {
            // Ignore depositId >= bnUInt32Max; these tend to be pre-fills that are eventually valid and
            // tend to confuse this reporting because there are multiple deposits with the same depositId.
            if (deposit.depositId < bnUint32Max && invalid.length > 0) {
              const invalidFills = Object.fromEntries(
                invalid.map(({ relayer, destinationChainId, depositId, txnRef, outputAmount }) => {
                  return [relayer, { destinationChainId, depositId, txnRef, outputAmount }];
                })
              );
              this.logger.warn({
                at: "SpokePoolClient",
                chainId: destinationChainId,
                message: `Unfilled deposit found matching ${getNetworkName(deposit.originChainId)} deposit.`,
                depositOutputAmount: deposit.outputAmount.toString(),
                depositTxnRef: deposit.txnRef,
                invalidFills,
                notificationPath: "across-unfilled-deposits",
              });
            }

            return deposit;
          }
        );

        const fillStatus = await spokePoolClients[destinationChainId].fillStatusArray(deposits);
        return [destinationChainId, deposits.filter((_, idx) => fillStatus[idx] !== FillStatus.Filled)];
      })
    );

    // Group unfilled amounts by chain id and token id.
    const unfilledAmountByChainAndToken: { [chainId: number]: { [tokenAddress: string]: BigNumber } } = {};
    Object.entries(unfilledDeposits).forEach(([_destinationChainId, deposits]) => {
      const chainId = Number(_destinationChainId);
      unfilledAmountByChainAndToken[chainId] ??= {};

      deposits.forEach(({ outputToken, outputAmount }) => {
        const unfilledAmount = unfilledAmountByChainAndToken[chainId][outputToken.toBytes32()] ?? bnZero;
        unfilledAmountByChainAndToken[chainId][outputToken.toBytes32()] = unfilledAmount.add(outputAmount);
      });
    });

    let mrkdwn = "";
    for (const [chainIdStr, amountByToken] of Object.entries(unfilledAmountByChainAndToken)) {
      // Skipping chains with no unfilled deposits.
      if (!amountByToken) {
        continue;
      }

      const chainId = parseInt(chainIdStr);
      mrkdwn += `*Destination: ${getNetworkName(chainId)}*\n`;
      for (const tokenAddress of Object.keys(amountByToken)) {
        let symbol: string;
        let unfilledAmount: string;
        try {
          let decimals: number;
          ({ symbol, decimals } = this.clients.hubPoolClient.getTokenInfoForAddress(
            toAddressType(tokenAddress, chainId),
            chainId
          ));
          unfilledAmount = convertFromWei(amountByToken[tokenAddress].toString(), decimals);
        } catch {
          symbol = tokenAddress; // Using the address helps investigation.
          unfilledAmount = amountByToken[tokenAddress].toString();
        }

        // Convert to number of tokens for readability.
        mrkdwn += `${symbol}: ${unfilledAmount}\n`;
      }
    }

    if (mrkdwn) {
      this.logger.info({ at: "Monitor#reportUnfilledDeposits", message: "Unfilled deposits ⏱", mrkdwn });
    }
  }

  async reportOpenHyperliquidOrders(): Promise<void> {
    // Piggyback off of the hyperliquid executor logic so that we can call `getOutstandingOrdersOnPair` for each configured pair.
    const hyperEvmSpoke = this.clients.spokePoolClients[CHAIN_IDs.HYPEREVM];
    assert(isEVMSpokePoolClient(hyperEvmSpoke));
    const dstProvider = hyperEvmSpoke.spokePool.provider;

    const hyperliquidExecutorConfig = new HyperliquidExecutorConfig(process.env);
    const hyperliquidExecutor = new HyperliquidExecutor(
      this.logger,
      {
        ...hyperliquidExecutorConfig,
        supportedTokens: this.monitorConfig.hyperliquidTokens,
        lookback: this.monitorConfig.hyperliquidOrderMaximumLifetime * 12, // Lookback is a function of lifetime.
      } as HyperliquidExecutorConfig,
      { ...this.clients, dstProvider }
    );
    await hyperliquidExecutor.initialize();

    const outstandingOrders = Object.fromEntries(
      await mapAsync(Object.entries(hyperliquidExecutor.pairs), async ([pairId, pair]) => [
        pairId,
        await hyperliquidExecutor.getOutstandingOrdersOnPair(pair),
      ])
    );
    const oldHyperliquidOrders: { [pairId: string]: SwapFlowInitialized & { age: number } } = Object.fromEntries(
      (
        await mapAsync(Object.entries(outstandingOrders), async ([pairId, orderSet]) => {
          // If no outstanding orders. Nothing to do, so return.
          if (orderSet.length === 0) {
            return undefined;
          }
          const sortedOrders = sortEventsAscending(orderSet);
          const earliestOrder = sortedOrders[0];
          const orderBlock = await dstProvider.getBlock(earliestOrder.blockNumber);
          const orderAge = Date.now() / 1000 - orderBlock.timestamp;
          if (orderAge > this.monitorConfig.hyperliquidOrderMaximumLifetime) {
            return [pairId, { ...earliestOrder, age: orderAge }];
          }
          return undefined;
        })
      ).filter(isDefined)
    );

    const nOutstandingOrders = Object.values(oldHyperliquidOrders).flat().length;
    if (Object.values(oldHyperliquidOrders).length !== 0) {
      const finalTokenBalances = await mapAsync(Object.keys(oldHyperliquidOrders), async (pairId) => {
        const [, finalTokenSymbol] = pairId.split("-");
        const pair = hyperliquidExecutor.pairs[pairId];
        return hyperliquidExecutor.querySpotBalance(finalTokenSymbol, pair.swapHandler, pair.finalTokenDecimals);
      });
      const formatter = createFormatFunction(2, 4, false, 8);
      this.logger.error({
        at: "Monitor#reportOpenHyperliquidOrders",
        message: "Old outstanding Hyperliquid orders",
        oldHyperliquidOrders,
        outstandingOrders: nOutstandingOrders,
        affectedPairs: Object.keys(oldHyperliquidOrders),
        affectedSwapHandlers: Object.keys(oldHyperliquidOrders).map((pairId) =>
          hyperliquidExecutor.pairs[pairId].swapHandler.toNative()
        ),
        approximateAmountShort: Object.values(oldHyperliquidOrders).map((order, idx) =>
          formatter(order.maxAmountToSend.sub(finalTokenBalances[idx]))
        ),
      });
    } else {
      this.logger.debug({
        at: "Monitor#reportOpenHyperliquidOrders",
        message: "No old outstanding Hyperliquid orders",
        outstandingOrders: outstandingOrders.length,
      });
    }
  }

  l2TokenAmountToL1TokenAmountConverter(l2Token: Address, chainId: number): (BigNumber) => BigNumber {
    // Step 1: Get l1 token address equivalent of L2 token
    const l1Token = getL1TokenAddress(l2Token, chainId);
    const l1TokenDecimals = getTokenInfo(l1Token, this.clients.hubPoolClient.chainId).decimals;
    const l2TokenDecimals = getTokenInfo(l2Token, chainId).decimals;
    return ConvertDecimals(l2TokenDecimals, l1TokenDecimals);
  }

  getL1TokensForRelayerBalancesReport(): L1Token[] {
    const allL1Tokens = [...this.l1Tokens, ...this.additionalL1Tokens].map(({ symbol, ...tokenInfo }) => {
      return {
        ...tokenInfo,
        // Remap symbols so that we're using a symbol available to us in TOKEN_SYMBOLS_MAP.
        symbol: TOKEN_EQUIVALENCE_REMAPPING[symbol] ?? symbol,
      };
    });
    // @dev Handle special case for L1 USDC which is mapped to two L2 tokens on some chains, so we can more easily
    // see L2 Bridged USDC balance versus Native USDC. Add USDC.e right after the USDC element.
    const indexOfUsdc = allL1Tokens.findIndex(({ symbol }) => symbol === "USDC");
    if (indexOfUsdc > -1 && TOKEN_SYMBOLS_MAP["USDC.e"].addresses[this.clients.hubPoolClient.chainId]) {
      allL1Tokens.splice(indexOfUsdc, 0, {
        symbol: "USDC.e",
        address: EvmAddress.from(TOKEN_SYMBOLS_MAP["USDC.e"].addresses[this.clients.hubPoolClient.chainId]),
        decimals: 6,
      });
    }
    return allL1Tokens;
  }

  async reportRelayerBalances(): Promise<void> {
    const relayers = this.monitorConfig.monitoredRelayers;
    const allL1Tokens = this.getL1TokensForRelayerBalancesReport();
    const l2OnlyTokens = this.l2OnlyTokens;

    const chainIds = this.monitorChains;
    const allChainNames = chainIds.map(getNetworkName).concat([ALL_CHAINS_NAME]);
    const reports = this.initializeBalanceReports(relayers, allL1Tokens, l2OnlyTokens, allChainNames);

    await this.updateCurrentRelayerBalances(reports);
    await this.updateLatestAndFutureRelayerRefunds(reports);

    for (const relayer of relayers) {
      const report = reports[relayer.toNative()];
      let summaryMrkdwn = "*[Summary]*\n";
      let mrkdwn = "Token amounts: current, pending execution, cross-chain transfers, total\n";

      // Report L1 tokens
      for (const token of allL1Tokens) {
        let tokenMrkdwn = "";
        for (const chainName of allChainNames) {
          const balancesBN = Object.values(report[token.symbol][chainName]);
          if (balancesBN.find((b) => b.gt(bnZero))) {
            // Human-readable balances
            const balances = balancesBN.map((balance) =>
              balance.gt(bnZero) ? convertFromWei(balance.toString(), token.decimals) : "0"
            );
            tokenMrkdwn += `${chainName}: ${balances.join(", ")}\n`;
          } else {
            // Shorten balances in the report if everything is 0.
            tokenMrkdwn += `${chainName}: 0\n`;
          }
        }

        const totalBalance = report[token.symbol][ALL_CHAINS_NAME][BalanceType.TOTAL];
        // Update corresponding summary section for current token.
        if (totalBalance.gt(bnZero)) {
          mrkdwn += `*[${token.symbol}]*\n` + tokenMrkdwn;
          summaryMrkdwn += `${token.symbol}: ${convertFromWei(totalBalance.toString(), token.decimals)}\n`;
        } else {
          summaryMrkdwn += `${token.symbol}: 0\n`;
        }
      }

      // Report L2-only tokens (only show tokens configured for this specific relayer)
      const l2OnlyTokensForRelayer = l2OnlyTokens.filter((token) => token.relayers.some((r) => r.eq(relayer)));
      for (const token of l2OnlyTokensForRelayer) {
        const chainName = getNetworkName(token.chainId);
        let tokenMrkdwn = "";

        // L2-only tokens only exist on their specific chain
        const balancesBN = Object.values(report[token.symbol]?.[chainName] ?? {});
        if (balancesBN.find((b) => b.gt(bnZero))) {
          const balances = balancesBN.map((balance) =>
            balance.gt(bnZero) ? convertFromWei(balance.toString(), token.decimals) : "0"
          );
          tokenMrkdwn += `${chainName}: ${balances.join(", ")}\n`;
        } else {
          tokenMrkdwn += `${chainName}: 0\n`;
        }

        const totalBalance = report[token.symbol]?.[ALL_CHAINS_NAME]?.[BalanceType.TOTAL] ?? bnZero;
        if (totalBalance.gt(bnZero)) {
          mrkdwn += `*[${token.symbol} (L2-only)]*\n` + tokenMrkdwn;
          summaryMrkdwn += `${token.symbol}: ${convertFromWei(totalBalance.toString(), token.decimals)}\n`;
        } else {
          summaryMrkdwn += `${token.symbol}: 0\n`;
        }
      }

      mrkdwn += summaryMrkdwn;
      this.logger.info({
        at: "Monitor#reportRelayerBalances",
        message: `Balance report for ${relayer} 📖`,
        mrkdwn,
      });
    }

    // Build a combined token list for decimal lookups in the debug logging
    const allTokensWithDecimals = new Map<string, number>();
    allL1Tokens.forEach((token) => allTokensWithDecimals.set(token.symbol, token.decimals));
    l2OnlyTokens.forEach((token) => allTokensWithDecimals.set(token.symbol, token.decimals));

    Object.entries(reports).forEach(([relayer, balanceTable]) => {
      Object.entries(balanceTable).forEach(([tokenSymbol, columns]) => {
        const decimals = allTokensWithDecimals.get(tokenSymbol);
        if (!decimals) {
          throw new Error(`No decimals found for ${tokenSymbol}`);
        }
        Object.entries(columns).forEach(([chainName, cell]) => {
          if (this._tokenEnabledForNetwork(tokenSymbol, chainName) || chainName === ALL_CHAINS_NAME) {
            Object.entries(cell).forEach(([balanceType, balance]) => {
              // Don't log zero balances.
              if (balance.isZero()) {
                return;
              }
              this.logger.debug({
                at: "Monitor#reportRelayerBalances",
                message: "Machine-readable single balance report",
                relayer,
                tokenSymbol,
                decimals,
                chainName,
                balanceType,
                balanceInWei: balance.toString(),
                balance: Number(utils.formatUnits(balance, decimals)),
                datadog: true,
              });
            });
          }
        });
      });
    });
  }

  // Update current balances of all tokens on each supported chain for each relayer.
  async updateCurrentRelayerBalances(relayerBalanceReport: RelayerBalanceReport): Promise<void> {
    const l1Tokens = this.getL1TokensForRelayerBalancesReport();
    const l2OnlyTokens = this.l2OnlyTokens;

    for (const relayer of this.monitorConfig.monitoredRelayers) {
      for (const chainId of this.monitorChains) {
        // If the monitored relayer address is invalid on the monitored chain (e.g. the monitored relayer is a base58 address while the chain ID is mainnet),
        // then there is no balance to update in this loop.
        if (!relayer.isValidOn(chainId)) {
          continue;
        }
        const l2ToL1Tokens = this.getL2ToL1TokenMap(l1Tokens, chainId);
        const l2TokenAddresses = Object.keys(l2ToL1Tokens);
        const tokenBalances = await this._getBalances(
          l2TokenAddresses.map((address) => ({
            token: toAddressType(address, chainId),
            chainId: chainId,
            account: relayer,
          }))
        );

        for (let i = 0; i < l2TokenAddresses.length; i++) {
          const decimalConverter = this.l2TokenAmountToL1TokenAmountConverter(
            toAddressType(l2TokenAddresses[i], chainId),
            chainId
          );
          const { symbol } = l2ToL1Tokens[l2TokenAddresses[i]];
          this.updateRelayerBalanceTable(
            relayerBalanceReport[relayer.toNative()],
            symbol,
            getNetworkName(chainId),
            BalanceType.CURRENT,
            decimalConverter(tokenBalances[i])
          );
        }

        // Handle L2-only tokens for this chain and this specific relayer
        const l2OnlyTokensForChainAndRelayer = l2OnlyTokens.filter(
          (token) => token.chainId === chainId && token.relayers.some((r) => r.eq(relayer))
        );
        if (l2OnlyTokensForChainAndRelayer.length > 0) {
          const l2OnlyBalances = await this._getBalances(
            l2OnlyTokensForChainAndRelayer.map((token) => ({
              token: token.address,
              chainId: chainId,
              account: relayer,
            }))
          );

          for (let i = 0; i < l2OnlyTokensForChainAndRelayer.length; i++) {
            const token = l2OnlyTokensForChainAndRelayer[i];
            // L2-only tokens don't need decimal conversion since they don't map to L1
            this.updateRelayerBalanceTable(
              relayerBalanceReport[relayer.toNative()],
              token.symbol,
              getNetworkName(chainId),
              BalanceType.CURRENT,
              l2OnlyBalances[i]
            );
          }
        }
      }
    }
  }

  // Returns a dictionary of L2 token addresses on this chain to their mapped L1 token info. For example, this
  // will return a dictionary for Optimism including WETH, WBTC, USDC, USDC.e, USDT entries where the key is
  // the token's Optimism address and the value is the equivalent L1 token info.
  protected getL2ToL1TokenMap(l1Tokens: L1Token[], chainId: number): { [l2TokenAddress: string]: L1Token } {
    return Object.fromEntries(
      l1Tokens
        .map((l1Token) => {
          // @dev l2TokenSymbols is a list of all keys in TOKEN_SYMBOLS_MAP where the hub chain address is equal to the
          // l1 token address.
          const l2TokenSymbols = Object.entries(TOKEN_SYMBOLS_MAP)
            .filter(
              ([, { addresses }]) =>
                addresses[this.clients.hubPoolClient.chainId]?.toLowerCase() ===
                l1Token.address.toEvmAddress().toLowerCase()
            )
            .map(([symbol]) => symbol);

          // Create an entry for all L2 tokens that share a symbol with the L1 token. This includes tokens
          // like USDC which has multiple L2 tokens mapped to the same L1 token for a given chain ID.
          return l2TokenSymbols
            .filter((symbol) => TOKEN_SYMBOLS_MAP[symbol].addresses[chainId] !== undefined)
            .map((symbol) => {
              if (chainId !== this.clients.hubPoolClient.chainId && sdkUtils.isBridgedUsdc(symbol)) {
                return [TOKEN_SYMBOLS_MAP[symbol].addresses[chainId], { ...l1Token, symbol: "USDC.e" }];
              } else {
                const remappedSymbol = TOKEN_EQUIVALENCE_REMAPPING[symbol] ?? symbol;
                return [TOKEN_SYMBOLS_MAP[symbol].addresses[chainId], { ...l1Token, symbol: remappedSymbol }];
              }
            });
        })
        .flat()
    );
  }

  async checkBalances(): Promise<void> {
    const { monitoredBalances } = this.monitorConfig;
    const balances = await this._getBalances(monitoredBalances);
    const decimalValues = await this._getDecimals(monitoredBalances);

    this.logger.debug({
      at: "Monitor#checkBalances",
      message: "Checking balances",
      currentBalances: monitoredBalances.map(({ chainId, token, account, warnThreshold, errorThreshold }, i) => {
        return {
          chainId,
          token,
          account,
          currentBalance: balances[i].toString(),
          warnThreshold: parseUnits(warnThreshold.toString(), decimalValues[i]),
          errorThreshold: parseUnits(errorThreshold.toString(), decimalValues[i]),
        };
      }),
    });
    const alerts = (
      await Promise.all(
        monitoredBalances.map(
          async (
            { chainId, token, account, warnThreshold, errorThreshold },
            i
          ): Promise<undefined | { level: "warn" | "error"; text: string }> => {
            const balance = balances[i];
            const decimals = decimalValues[i];
            let trippedThreshold: { level: "warn" | "error"; threshold: number } | null = null;

            if (warnThreshold !== null && balance.lt(parseUnits(warnThreshold.toString(), decimals))) {
              trippedThreshold = { level: "warn", threshold: warnThreshold };
            }
            if (errorThreshold !== null && balance.lt(parseUnits(errorThreshold.toString(), decimals))) {
              trippedThreshold = { level: "error", threshold: errorThreshold };
            }
            if (trippedThreshold !== null) {
              let symbol;
              const nativeTokenForChain = getNativeTokenAddressForChain(chainId);
              if (token.eq(nativeTokenForChain)) {
                symbol = getNativeTokenSymbol(chainId);
              } else {
                const spokePoolClient = this.clients.spokePoolClients[chainId];
                if (isEVMSpokePoolClient(spokePoolClient)) {
                  symbol = await new Contract(
                    token.toEvmAddress(),
                    ERC20.abi,
                    spokePoolClient.spokePool.provider
                  ).symbol();
                } else {
                  symbol = getTokenInfo(token, chainId).symbol;
                }
              }
              return {
                level: trippedThreshold.level,
                text: `  ${getNetworkName(chainId)} ${symbol} balance for ${blockExplorerLink(
                  account.toNative(),
                  chainId
                )} is ${formatUnits(balance, decimals)}. Threshold: ${trippedThreshold.threshold}`,
              };
            }
          }
        )
      )
    ).filter((text) => text !== undefined);
    if (alerts.length > 0) {
      // Just send out the maximum alert level rather than splitting into warnings and errors.
      const maxAlertlevel = alerts.some((alert) => alert.level === "error") ? "error" : "warn";
      const mrkdwn =
        "Some balance(s) are below the configured threshold!\n" + alerts.map(({ text }) => text).join("\n");
      this.logger[maxAlertlevel]({ at: "Monitor", message: "Balance(s) below threshold", mrkdwn: mrkdwn });
    }
  }

  async checkBinanceWithdrawalLimits() {
    const binanceApi = await getBinanceApiClient(process.env["BINANCE_API_BASE"]);
    const wdQuota = await getBinanceWithdrawalLimits(binanceApi);
    const aboveWarnThreshold =
      isDefined(this.monitorConfig.binanceWithdrawWarnThreshold) &&
      wdQuota.usedWdQuota / wdQuota.wdQuota > this.monitorConfig.binanceWithdrawWarnThreshold;
    const aboveAlertThreshold =
      isDefined(this.monitorConfig.binanceWithdrawAlertThreshold) &&
      wdQuota.usedWdQuota / wdQuota.wdQuota > this.monitorConfig.binanceWithdrawAlertThreshold;

    const level = aboveAlertThreshold ? "error" : aboveWarnThreshold ? "warn" : "debug";
    this.logger[level]({
      at: "Monitor#checkBinanceWithdrawalLimits",
      message: "Binance withdrawal quota",
      datadog: true,
      wdQuota,
    });
  }

  async checkSpokePoolRunningBalances(): Promise<void> {
    // We define a custom format function since we do not want the same precision that `convertFromWei` gives us.
    const formatWei = (weiVal: string, decimals: number) =>
      weiVal === "0" ? "0" : createFormatFunction(1, 4, false, decimals)(weiVal);

    const hubPoolClient = this.clients.hubPoolClient;
    const monitoredTokenSymbols = this.monitorConfig.monitoredTokenSymbols;

    // Define the chain IDs in the same order as `enabledChainIds` so that block range ordering is preserved.
    const chainIds =
      this.monitorConfig.monitoredSpokePoolChains.length !== 0
        ? this.monitorChains.filter((chain) => this.monitorConfig.monitoredSpokePoolChains.includes(chain))
        : this.monitorChains;

    const l2TokenForChain = (chainId: number, symbol: string) => {
      const _l2Token = TOKEN_SYMBOLS_MAP[symbol]?.addresses[chainId];
      return isDefined(_l2Token) ? toAddressType(_l2Token, chainId) : undefined;
    };
    const pendingRelayerRefunds = {};
    const pendingRebalanceRoots = {};

    // Take the validated bundles from the hub pool client.
    const validatedBundles = sortEventsDescending(hubPoolClient.getValidatedRootBundles()).slice(
      0,
      this.monitorConfig.bundlesCount
    );

    // Fetch the data from the latest root bundle.
    const bundle = hubPoolClient.getLatestProposedRootBundle();
    const nextBundleMainnetStartBlock = hubPoolClient.getNextBundleStartBlockNumber(
      this.clients.bundleDataClient.chainIdListForBundleEvaluationBlockNumbers,
      hubPoolClient.latestHeightSearched,
      hubPoolClient.chainId
    );
    const enabledChainIds = this.clients.configStoreClient.getChainIdIndicesForBlock(nextBundleMainnetStartBlock);

    this.logger.debug({
      at: "Monitor#checkSpokePoolRunningBalances",
      message: "Mainnet root bundles in scope",
      validatedBundles,
      outstandingBundle: bundle,
    });

    const slowFillBlockRange = await getWidestPossibleExpectedBlockRange(
      enabledChainIds,
      this.clients.spokePoolClients,
      getEndBlockBuffers(enabledChainIds, this.clients.bundleDataClient.blockRangeEndBlockBuffer),
      this.clients,
      hubPoolClient.latestHeightSearched,
      this.clients.configStoreClient.getEnabledChains(hubPoolClient.latestHeightSearched)
    );
    const blockRangeTail = bundle.bundleEvaluationBlockNumbers.map((endBlockForChain, idx) => {
      const endBlockNumber = Number(endBlockForChain);
      const spokeLatestBlockSearched = this.clients.spokePoolClients[enabledChainIds[idx]]?.latestHeightSearched ?? 0;
      return spokeLatestBlockSearched === 0
        ? [endBlockNumber, endBlockNumber]
        : [endBlockNumber + 1, spokeLatestBlockSearched > endBlockNumber ? spokeLatestBlockSearched : endBlockNumber];
    });

    this.logger.debug({
      at: "Monitor#checkSpokePoolRunningBalances",
      message: "Block ranges to search",
      slowFillBlockRange,
      blockRangeTail,
    });

    const lastProposedBundleBlockRanges = getImpliedBundleBlockRanges(
      hubPoolClient,
      this.clients.configStoreClient,
      hubPoolClient.hasPendingProposal()
        ? hubPoolClient.getLatestProposedRootBundle()
        : hubPoolClient.getNthFullyExecutedRootBundle(-1)
    );
    // Do all async tasks in parallel. We want to know about the pool rebalances, slow fills in the most recent proposed bundle, refunds
    // from the last `n` bundles, pending refunds which have not been made official via a root bundle proposal, and the current balances of
    // all the spoke pools.
    const [poolRebalanceRoot, currentBundleData, currentSpokeBalances] = await Promise.all([
      this.clients.bundleDataClient.loadData(lastProposedBundleBlockRanges, this.clients.spokePoolClients, true),
      this.clients.bundleDataClient.loadData(slowFillBlockRange, this.clients.spokePoolClients, true),
      Object.fromEntries(
        await mapAsync(chainIds, async (chainId) => {
          const spokePool = this.clients.spokePoolClients[chainId].spokePoolAddress;
          const l2TokenAddresses = monitoredTokenSymbols
            .map((symbol) => l2TokenForChain(chainId, symbol))
            .filter(isDefined);
          const balances = Object.fromEntries(
            await mapAsync(l2TokenAddresses, async (l2Token) => [
              l2Token,
              (
                await this._getBalances([
                  {
                    token: l2Token,
                    chainId: chainId,
                    account: spokePool,
                  },
                ])
              )[0],
            ])
          );
          return [chainId, balances];
        })
      ),
    ]);

    const poolRebalanceLeaves = (
      await _buildPoolRebalanceRoot(
        lastProposedBundleBlockRanges[0][1],
        lastProposedBundleBlockRanges[0][1],
        poolRebalanceRoot.bundleDepositsV3,
        poolRebalanceRoot.bundleFillsV3,
        poolRebalanceRoot.bundleSlowFillsV3,
        poolRebalanceRoot.unexecutableSlowFills,
        poolRebalanceRoot.expiredDepositsToRefundV3,
        this.clients
      )
    ).leaves;

    // Get the pool rebalance leaf amounts.
    const enabledTokens = [...this.l1Tokens];
    for (const leaf of poolRebalanceLeaves) {
      if (!chainIds.includes(leaf.chainId)) {
        continue;
      }
      const l2TokenMap = this.getL2ToL1TokenMap(enabledTokens, leaf.chainId);
      pendingRebalanceRoots[leaf.chainId] = {};
      Object.entries(l2TokenMap).forEach(([l2Token, l1Token]) => {
        const rebalanceAmount =
          leaf.netSendAmounts[
            leaf.l1Tokens
              .map((l1Token) => l1Token.toEvmAddress())
              .findIndex((token) => token === l1Token.address.toEvmAddress())
          ];
        pendingRebalanceRoots[leaf.chainId][l2Token] = rebalanceAmount ?? bnZero;
      });
    }

    this.logger.debug({
      at: "Monitor#checkSpokePoolRunningBalances",
      message: "Print pool rebalance leaves",
      poolRebalanceRootLeaves: poolRebalanceLeaves,
    });

    // Calculate the pending refunds.
    for (const chainId of chainIds) {
      const l2TokenMap = this.getL2ToL1TokenMap(enabledTokens, chainId);
      const l2TokenAddresses = monitoredTokenSymbols
        .map((symbol) => l2TokenForChain(chainId, symbol))
        .filter(isDefined);
      pendingRelayerRefunds[chainId] = {};
      l2TokenAddresses.forEach((l2Token) => {
        const l1Token = l2TokenMap[l2Token.toNative()];
        const upcomingBundleRefunds = this.getUpcomingRefunds(chainId, l1Token.address);
        pendingRelayerRefunds[chainId][l2Token.toNative()] = upcomingBundleRefunds;
      });

      this.logger.debug({
        at: "Monitor#checkSpokePoolRunningBalances",
        message: "Print refund amounts for chainId",
        chainId,
        pendingDeductions: pendingRelayerRefunds[chainId],
      });
    }

    // Get the slow fill amounts. Only do this step if there were slow fills in the most recent root bundle.
    Object.entries(currentBundleData.bundleSlowFillsV3)
      .filter(([chainId]) => chainIds.includes(+chainId))
      .map(([chainId, bundleSlowFills]) => {
        const l2TokenAddresses = monitoredTokenSymbols
          .map((symbol) => l2TokenForChain(+chainId, symbol))
          .filter(isDefined);
        Object.entries(bundleSlowFills)
          .filter(([l2Token]) => l2TokenAddresses.map((_l2Token) => _l2Token.toBytes32()).includes(l2Token))
          .map(([l2Token, fills]) => {
            const _l2Token = toAddressType(l2Token, +chainId);
            const pendingSlowFillAmounts = fills
              .map((fill) => fill.outputAmount)
              .filter(isDefined)
              .reduce((totalAmounts, outputAmount) => totalAmounts.add(outputAmount), bnZero);
            pendingRelayerRefunds[chainId][_l2Token.toNative()] =
              pendingRelayerRefunds[chainId][_l2Token.toNative()].add(pendingSlowFillAmounts);
          });
      });

    // Print the output: The current spoke pool balance, the amount of refunds to payout, the pending pool rebalances, and then the sum of the three.
    let tokenMarkdown =
      "Token amounts: current, pending relayer refunds, pool rebalances, adjusted spoke pool balance\n";
    for (const tokenSymbol of monitoredTokenSymbols) {
      tokenMarkdown += `*[${tokenSymbol}]*\n`;
      for (const chainId of chainIds) {
        const tokenAddress = l2TokenForChain(chainId, tokenSymbol);

        // If the token does not exist on the chain, then ignore this report.
        if (!isDefined(tokenAddress)) {
          continue;
        }

        const tokenDecimals = resolveTokenDecimals(tokenSymbol);
        const currentSpokeBalance = formatWei(
          currentSpokeBalances[chainId][tokenAddress.toNative()].toString(),
          tokenDecimals
        );

        // Relayer refunds may be undefined when there were no refunds included in the last bundle.
        const currentRelayerRefunds = formatWei(
          (pendingRelayerRefunds[chainId]?.[tokenAddress.toNative()] ?? bnZero).toString(),
          tokenDecimals
        );
        // Rebalance roots will be undefined when there was no root in the last bundle for the chain.
        const currentRebalanceRoots = formatWei(
          (pendingRebalanceRoots[chainId]?.[tokenAddress.toNative()] ?? bnZero).toString(),
          tokenDecimals
        );
        const virtualSpokeBalance = formatWei(
          currentSpokeBalances[chainId][tokenAddress.toNative()]
            .add(pendingRebalanceRoots[chainId]?.[tokenAddress.toNative()] ?? bnZero)
            .sub(pendingRelayerRefunds[chainId]?.[tokenAddress.toNative()] ?? bnZero)
            .toString(),
          tokenDecimals
        );
        tokenMarkdown += `${getNetworkName(chainId)}: `;
        tokenMarkdown +=
          currentSpokeBalance +
          `, ${currentRelayerRefunds !== "0" ? "-" : ""}` +
          currentRelayerRefunds +
          ", " +
          currentRebalanceRoots +
          ", " +
          virtualSpokeBalance +
          "\n";
      }
    }
    this.logger.info({
      at: "Monitor#checkSpokePoolRunningBalances",
      message: "Spoke pool balance report",
      mrkdwn: tokenMarkdown,
    });
  }

  // We approximate stuck rebalances by checking if there are still any pending cross chain transfers to any SpokePools
  // some fixed amount of time (grace period) after the last bundle execution. This can give false negative if there are
  // transfers stuck for longer than 1 bundle and the current time is within the last bundle execution + grace period.
  // But this should be okay as we should address any stuck transactions immediately so realistically no transfers
  // should stay unstuck for longer than one bundle.
  async checkStuckRebalances(): Promise<void> {
    const hubPoolClient = this.clients.hubPoolClient;
    const { currentTime, latestHeightSearched } = hubPoolClient;
    const lastFullyExecutedBundle = hubPoolClient.getLatestFullyExecutedRootBundle(latestHeightSearched);
    // This case shouldn't happen outside of tests as Across V2 has already launched.
    if (lastFullyExecutedBundle === undefined) {
      return;
    }
    const lastFullyExecutedBundleTime = lastFullyExecutedBundle.challengePeriodEndTimestamp;

    const allL1Tokens = this.l1Tokens;
    const poolRebalanceLeaves = this.clients.hubPoolClient.getExecutedLeavesForRootBundle(
      lastFullyExecutedBundle,
      latestHeightSearched
    );
    for (const chainId of this.crossChainAdapterSupportedChains) {
      // Exit early if there were no pool rebalance leaves for this chain executed in the last bundle.
      const poolRebalanceLeaf = poolRebalanceLeaves.find((leaf) => leaf.chainId === chainId);
      if (!poolRebalanceLeaf) {
        this.logger.debug({
          at: "Monitor#checkStuckRebalances",
          message: `No pool rebalance leaves for ${getNetworkName(chainId)} in last bundle`,
        });
        continue;
      }
      const gracePeriod = EXPECTED_L1_TO_L2_MESSAGE_TIME[chainId] ?? REBALANCE_FINALIZE_GRACE_PERIOD;
      // If we're still within the grace period, skip looking for any stuck rebalances.
      // Again, this would give false negatives for transfers that have been stuck for longer than one bundle if the
      // current time is within the grace period of last executed bundle. But this is a good trade off for simpler code.
      if (lastFullyExecutedBundleTime + gracePeriod > currentTime) {
        this.logger.debug({
          at: "Monitor#checkStuckRebalances",
          message: `Within ${gracePeriod / 60}min grace period of last bundle execution for ${getNetworkName(chainId)}`,
          lastFullyExecutedBundleTime,
          currentTime,
        });
        continue;
      }

      // If chain wasn't active in latest bundle, then skip it.
      const chainIndex = this.clients.hubPoolClient.configStoreClient.getChainIdIndicesForBlock().indexOf(chainId);
      if (chainIndex >= lastFullyExecutedBundle.bundleEvaluationBlockNumbers.length) {
        continue;
      }

      // First, log if the root bundle never relayed to the spoke pool.
      const rootBundleRelay = this.clients.spokePoolClients[chainId].getRootBundleRelays().find((relay) => {
        return (
          relay.relayerRefundRoot === lastFullyExecutedBundle.relayerRefundRoot &&
          relay.slowRelayRoot === lastFullyExecutedBundle.slowRelayRoot
        );
      });
      if (!rootBundleRelay) {
        this.logger.warn({
          at: "Monitor#checkStuckRebalances",
          message: `HubPool -> ${getNetworkName(chainId)} SpokePool root bundle relay stuck 👨🏻‍🦽‍➡️`,
          lastFullyExecutedBundle,
        });
      }

      const spokePoolAddress = this.clients.spokePoolClients[chainId].spokePoolAddress;
      for (const l1Token of allL1Tokens) {
        // Outstanding transfers are mapped to either the spoke pool or the hub pool, depending on which
        // chain events are queried. Some only allow us to index on the fromAddress, the L1 originator or the
        // HubPool, while others only allow us to index on the toAddress, the L2 recipient or the SpokePool.
        const transferBalance = this.clients.crossChainTransferClient
          .getOutstandingCrossChainTransferAmount(spokePoolAddress, chainId, l1Token.address)
          .add(
            this.clients.crossChainTransferClient.getOutstandingCrossChainTransferAmount(
              toAddressType(this.clients.hubPoolClient.hubPool.address, this.clients.hubPoolClient.chainId),
              chainId,
              l1Token.address
            )
          );
        const outstandingDepositTxs = blockExplorerLinks(
          this.clients.crossChainTransferClient.getOutstandingCrossChainTransferTxs(
            spokePoolAddress,
            chainId,
            l1Token.address
          ),
          1
        ).concat(
          blockExplorerLinks(
            this.clients.crossChainTransferClient.getOutstandingCrossChainTransferTxs(
              toAddressType(this.clients.hubPoolClient.hubPool.address, this.clients.hubPoolClient.chainId),
              chainId,
              l1Token.address
            ),
            1
          )
        );

        if (transferBalance.gt(0)) {
          const mrkdwn = `Rebalances of ${l1Token.symbol} to ${getNetworkName(chainId)} is stuck`;
          this.logger.warn({
            at: "Monitor#checkStuckRebalances",
            message: "HubPool -> SpokePool rebalances stuck 🦴",
            mrkdwn,
            transferBalance: transferBalance.toString(),
            outstandingDepositTxs,
          });
        }
      }
    }
  }

  async closePDAs(): Promise<void> {
    const simulate = process.env["SEND_TRANSACTIONS"] !== "true";
    const svmSpokePoolClient = this.clients.spokePoolClients[CHAIN_IDs.SOLANA];
    if (!isSVMSpokePoolClient(svmSpokePoolClient)) {
      return;
    }
    const fills: FillWithBlock[] = [];
    for (const relayers of this.monitorConfig.monitoredRelayers) {
      const relayerFills = svmSpokePoolClient.getFillsForRelayer(relayers);
      fills.push(...relayerFills);
    }

    const spokePoolProgramId = address(svmSpokePoolClient.spokePoolAddress.toBase58());
    const signer = await getKitKeypairFromEvmSigner(this.clients.hubPoolClient.hubPool.signer);
    const svmRpc = svmSpokePoolClient.svmEventsClient.getRpc();
    const noClosePdaTxs = [];
    for (const fill of fills) {
      const relayData = getRelayDataFromFill(fill);
      const relayDataWithMessageHash = {
        ...relayData,
        messageHash: fill.messageHash,
      };
      const fillStatus = await svmSpokePoolClient.relayFillStatus(relayDataWithMessageHash, fill.destinationChainId);
      // If fill PDA should not be closed, skip.
      if (!this._shouldCloseFillPDA(fillStatus, fill.fillDeadline, svmSpokePoolClient.getCurrentTime())) {
        noClosePdaTxs.push(fill);
        continue;
      }

      const fillStatusPda = await getFillStatusPda(
        spokePoolProgramId,
        relayDataWithMessageHash,
        fill.destinationChainId
      );
      // Check if PDA is already closed
      const fillStatusPdaAccount = await fetchEncodedAccount(svmRpc, fillStatusPda);
      if (!fillStatusPdaAccount.exists) {
        continue;
      }

      const closePdaInstruction = await arch.svm.createCloseFillPdaInstruction(signer, svmRpc, fillStatusPda);
      const signedTransaction = await signTransactionMessageWithSigners(closePdaInstruction);
      const encodedTransaction = getBase64EncodedWireTransaction(signedTransaction);

      if (simulate) {
        const result = await svmRpc
          .simulateTransaction(encodedTransaction, {
            encoding: "base64",
          })
          .send();
        if (result.value.err) {
          this.logger.warn({
            at: "Monitor#closePDAs",
            message: `Failed to close PDA for fill ${fill.txnRef}`,
            error: result.value.err,
          });
        }
        continue;
      }

      try {
        await svmRpc
          .sendTransaction(encodedTransaction, { preflightCommitment: "confirmed", encoding: "base64" })
          .send();

        this.logger.info({
          at: "Monitor#closePDAs",
          message: `Closed PDA ${fillStatusPda} for fill ${fill.txnRef}`,
        });
      } catch (err) {
        this.logger.warn({
          at: "Monitor#closePDAs",
          message: `Failed to close PDA for fill ${fill.txnRef}`,
          error: err,
        });
      }
    }

    if (noClosePdaTxs.length > 0) {
      this.logger.debug({
        at: "Monitor#closePDAs",
        message: `Number of PDAs that are not ready to be closed: ${noClosePdaTxs.length}`,
      });
    }
  }

  async updateLatestAndFutureRelayerRefunds(relayerBalanceReport: RelayerBalanceReport): Promise<void> {
    // Calculate which fills have not yet been refunded for each monitored relayer.
    const allL1Tokens = this.getL1TokensForRelayerBalancesReport();
    for (const relayer of this.monitorConfig.monitoredRelayers) {
      for (const l1Token of allL1Tokens) {
        for (const chainId of this.monitorChains) {
          if (l1Token.symbol === "USDC.e") {
            // We don't want to double count USDC/USDC.e repayments. When this.getUpcomingRefunds() is queried for a
            // specific L1 token address, it will return either USDC.e and USDC repayments--depending on the 'native' USDC
            // for the L2 chain in question. USDC.e is a special token injected into
            // this.getL1TokensForRelayerBalancesReport() so we can skip it here.
            continue;
          }
          const upcomingRefunds = this.getUpcomingRefunds(chainId, l1Token.address, relayer);
          if (upcomingRefunds.gt(0)) {
            const l2TokenAddress = getRemoteTokenForL1Token(
              l1Token.address,
              chainId,
              this.clients.hubPoolClient.chainId
            );
            const decimalConverter = this.l2TokenAmountToL1TokenAmountConverter(l2TokenAddress, chainId);
            this.updateRelayerBalanceTable(
              relayerBalanceReport[relayer.toNative()],
              l1Token.symbol,
              getNetworkName(chainId),
              BalanceType.PENDING,
              decimalConverter(upcomingRefunds)
            );
          }
        }
      }
    }
    for (const relayer of this.monitorConfig.monitoredRelayers) {
      this.updateCrossChainTransfers(relayer, relayerBalanceReport[relayer.toNative()]);
    }
    await Promise.all(
      this.monitorConfig.monitoredRelayers.map(async (relayer) => {
        await this.updatePendingL2Withdrawals(relayer, relayerBalanceReport[relayer.toNative()]);
      })
    );
  }

  getUpcomingRefunds(chainId: number, l1Token: Address, relayer?: Address): BigNumber {
    return this.bundleDataApproxClient.getUpcomingRefunds(chainId, l1Token, relayer);
  }

  updateCrossChainTransfers(relayer: Address, relayerBalanceTable: RelayerBalanceTable): void {
    const allL1Tokens = this.getL1TokensForRelayerBalancesReport();
    const supportedChains = this.crossChainAdapterSupportedChains.filter((chainId) =>
      this.monitorChains.includes(chainId)
    );
    for (const chainId of supportedChains) {
      const l2ToL1Tokens = this.getL2ToL1TokenMap(allL1Tokens, chainId);
      const l2TokenAddresses = Object.keys(l2ToL1Tokens);

      for (const l2Token of l2TokenAddresses) {
        const tokenInfo = l2ToL1Tokens[l2Token];
        const bridgedTransferBalance = this.clients.crossChainTransferClient.getOutstandingCrossChainTransferAmount(
          relayer,
          chainId,
          tokenInfo.address,
          toAddressType(l2Token, chainId)
        );
        this.updateRelayerBalanceTable(
          relayerBalanceTable,
          tokenInfo.symbol,
          getNetworkName(chainId),
          BalanceType.PENDING_TRANSFERS,
          bridgedTransferBalance
        );
      }
    }
  }

  async updatePendingL2Withdrawals(relayer: Address, relayerBalanceTable: RelayerBalanceTable): Promise<void> {
    const allL1Tokens = this.getL1TokensForRelayerBalancesReport();
    const supportedChains = this.crossChainAdapterSupportedChains.filter(
      (chainId) => this.monitorChains.includes(chainId) && chainId !== CHAIN_IDs.BSC // @todo temporarily skip BSC as the following
      // getTotalPendingWithdrawalAmount() async call is getting rate limited by the Binance API.
      // We should add more rate limiting or retry logic to this call.
    );
    await Promise.all(
      allL1Tokens.map(async (l1Token) => {
        const pendingWithdrawalBalances =
          await this.clients.crossChainTransferClient.adapterManager.getTotalPendingWithdrawalAmount(
            7200,
            supportedChains,
            relayer,
            l1Token.address
          );
        for (const _chainId of Object.keys(pendingWithdrawalBalances)) {
          const chainId = Number(_chainId);
          if (pendingWithdrawalBalances[chainId].eq(bnZero)) {
            continue;
          }
          if (!this.clients.crossChainTransferClient.adapterManager.l2TokenExistForL1Token(l1Token.address, chainId)) {
            return;
          }
          const l2Token = this.clients.crossChainTransferClient.adapterManager.l2TokenForL1Token(
            l1Token.address,
            chainId
          );
          const l2TokenInfo = getTokenInfo(l2Token, chainId);
          const l2ToL1DecimalConverter = sdkUtils.ConvertDecimals(l2TokenInfo.decimals, l1Token.decimals);
          // Add pending withdrawals as a "cross chain transfer" to the hub balance
          this.updateRelayerBalanceTable(
            relayerBalanceTable,
            l1Token.symbol,
            getNetworkName(this.clients.hubPoolClient.chainId),
            BalanceType.PENDING_TRANSFERS,
            l2ToL1DecimalConverter(pendingWithdrawalBalances[Number(chainId)])
          );
        }
      })
    );
  }

  getTotalTransferAmount(transfers: TokenTransfer[]): BigNumber {
    return transfers.map((transfer) => transfer.value).reduce((a, b) => a.add(b));
  }

  initializeBalanceReports(
    relayers: Address[],
    allL1Tokens: L1Token[],
    l2OnlyTokens: L2OnlyToken[],
    allChainNames: string[]
  ): RelayerBalanceReport {
    const reports: RelayerBalanceReport = {};
    for (const relayer of relayers) {
      reports[relayer.toNative()] = {};

      // Initialize L1 tokens for all chains
      for (const token of allL1Tokens) {
        reports[relayer.toNative()][token.symbol] = {};
        for (const chainName of allChainNames) {
          reports[relayer.toNative()][token.symbol][chainName] = {};
          for (const balanceType of ALL_BALANCE_TYPES) {
            reports[relayer.toNative()][token.symbol][chainName][balanceType] = bnZero;
          }
        }
      }

      // Initialize L2-only tokens only for their specific relayer, chain, and the "All chains" summary
      const l2OnlyTokensForRelayer = l2OnlyTokens.filter((token) => token.relayers.some((r) => r.eq(relayer)));
      for (const token of l2OnlyTokensForRelayer) {
        const tokenChainName = getNetworkName(token.chainId);
        reports[relayer.toNative()][token.symbol] = {};
        // Initialize for the specific chain the token exists on
        reports[relayer.toNative()][token.symbol][tokenChainName] = {};
        for (const balanceType of ALL_BALANCE_TYPES) {
          reports[relayer.toNative()][token.symbol][tokenChainName][balanceType] = bnZero;
        }
        // Initialize for "All chains" summary
        reports[relayer.toNative()][token.symbol][ALL_CHAINS_NAME] = {};
        for (const balanceType of ALL_BALANCE_TYPES) {
          reports[relayer.toNative()][token.symbol][ALL_CHAINS_NAME][balanceType] = bnZero;
        }
      }
    }
    return reports;
  }
  protected getRemoteTokenForL1Token(l1Token: EvmAddress, chainId: number | string): Address | undefined {
    return chainId === this.clients.hubPoolClient.chainId
      ? l1Token
      : getRemoteTokenForL1Token(l1Token, chainId, this.clients.hubPoolClient.chainId);
  }

  private updateRelayerBalanceTable(
    relayerBalanceTable: RelayerBalanceTable,
    tokenSymbol: string,
    chainName: string,
    balanceType: BalanceType,
    amount: BigNumber
  ) {
    this.incrementBalance(relayerBalanceTable, tokenSymbol, chainName, balanceType, amount);

    // We want to update the total balance when there are changes to each individual balance.
    this.incrementBalance(relayerBalanceTable, tokenSymbol, chainName, BalanceType.TOTAL, amount);

    // We want to update the all chains column for any changes to each chain's column.
    this.incrementBalance(relayerBalanceTable, tokenSymbol, ALL_CHAINS_NAME, balanceType, amount);
    this.incrementBalance(relayerBalanceTable, tokenSymbol, ALL_CHAINS_NAME, BalanceType.TOTAL, amount);
  }

  private incrementBalance(
    relayerBalanceTable: RelayerBalanceTable,
    tokenSymbol: string,
    chainName: string,
    balanceType: BalanceType,
    amount: BigNumber
  ) {
    relayerBalanceTable[tokenSymbol][chainName][balanceType] =
      relayerBalanceTable[tokenSymbol][chainName][balanceType].add(amount);
  }

  private notifyIfUnknownCaller(caller: string, action: BundleAction, txnRef: string) {
    if (
      this.monitorConfig.whitelistedDataworkers.some((dataworker) =>
        dataworker.eq(toAddressType(caller, CHAIN_IDs.MAINNET))
      )
    ) {
      return;
    }

    let emoji = "";
    switch (action) {
      case BundleAction.PROPOSED:
        emoji = "🥸";
        break;
      case BundleAction.DISPUTED:
        emoji = "🧨";
        break;
      case BundleAction.CANCELED:
        emoji = "🪓";
        break;
    }

    const mrkdwn =
      `An unknown EOA ${blockExplorerLink(caller, 1)} has ${action} a bundle on ${getNetworkName(1)}` +
      `\ntx: ${blockExplorerLink(txnRef, 1)}`;
    this.logger.error({
      at: "Monitor#notifyIfUnknownCaller",
      message: `Unknown bundle caller (${action}) ${emoji}${
        action === BundleAction.PROPOSED
          ? `. If proposer identity cannot be determined quickly, then the safe response is to call "disputeRootBundle" on the HubPool here ${blockExplorerLink(
              this.clients.hubPoolClient.hubPool.address,
              1
            )}. Note that you will need to approve the HubPool to transfer 0.4 WETH from your wallet as a dispute bond.`
          : ""
      }`,
      mrkdwn,
    });
  }

  private async computeHubPoolBlocks() {
    const { startingBlock, endingBlock } = await this.computeStartingAndEndingBlock(
      this.clients.hubPoolClient.hubPool.provider,
      this.monitorConfig.hubPoolStartingBlock,
      this.monitorConfig.hubPoolEndingBlock
    );
    this.hubPoolStartingBlock = startingBlock;
    this.hubPoolEndingBlock = endingBlock;
  }

  private async computeSpokePoolsBlocks() {
    for (const chainId of this.monitorChains) {
      const spokePoolClient = this.clients.spokePoolClients[chainId];
      if (isEVMSpokePoolClient(spokePoolClient)) {
        const { startingBlock, endingBlock } = await this.computeStartingAndEndingBlock(
          spokePoolClient.spokePool.provider,
          this.monitorConfig.spokePoolsBlocks[chainId]?.startingBlock,
          this.monitorConfig.spokePoolsBlocks[chainId]?.endingBlock
        );
        this.spokePoolsBlocks[chainId].startingBlock = startingBlock;
        this.spokePoolsBlocks[chainId].endingBlock = endingBlock;
      } else if (isSVMSpokePoolClient(spokePoolClient)) {
        const svmProvider = spokePoolClient.svmEventsClient.getRpc();
        const { slot: latestSlot } = await arch.svm.getNearestSlotTime(
          svmProvider,
          { commitment: "confirmed" },
          spokePoolClient.logger
        );
        const endingBlock = this.monitorConfig.spokePoolsBlocks[chainId]?.endingBlock;
        this.monitorConfig.spokePoolsBlocks[chainId] ??= { startingBlock: undefined, endingBlock: undefined };
        if (this.monitorConfig.pollingDelay === 0) {
          this.monitorConfig.spokePoolsBlocks[chainId].startingBlock ??= Number(latestSlot);
        } else {
          this.monitorConfig.spokePoolsBlocks[chainId].startingBlock = endingBlock;
        }
        this.monitorConfig.spokePoolsBlocks[chainId].endingBlock = Number(latestSlot);
      }
    }
  }

  // Compute the starting and ending block for each chain giving the provider and the config values
  private async computeStartingAndEndingBlock(
    provider: providers.Provider,
    configuredStartingBlock: number | undefined,
    configuredEndingBlock: number | undefined
  ) {
    // In serverless mode (pollingDelay === 0) use block range from environment (or just the latest block if not
    // provided) to fetch for latest events.
    // Else, if running in loop mode (pollingDelay != 0), start with the latest block and on next loops continue from
    // where the last one ended.
    const latestBlockNumber = (await provider.getBlock("latest")).number;
    let finalStartingBlock: number;
    let finalEndingBlock: number;

    if (this.monitorConfig.pollingDelay === 0) {
      finalStartingBlock = configuredStartingBlock !== undefined ? configuredStartingBlock : latestBlockNumber;
      finalEndingBlock = configuredEndingBlock !== undefined ? configuredEndingBlock : latestBlockNumber;
    } else {
      finalStartingBlock = configuredEndingBlock ? configuredEndingBlock + 1 : latestBlockNumber;
      finalEndingBlock = latestBlockNumber;
    }

    // Starting block should not be after the ending block. this could happen on short polling period or misconfiguration.
    finalStartingBlock = Math.min(finalStartingBlock, finalEndingBlock);

    return {
      startingBlock: finalStartingBlock,
      endingBlock: finalEndingBlock,
    };
  }

  // Returns balances from cache or from provider if there's a cache miss.
  private async _getBalances(balanceRequests: BalanceRequest[]): Promise<BigNumber[]> {
    return await Promise.all(
      balanceRequests.map(async ({ chainId, token, account }) => {
        if (this.balanceCache[chainId]?.[token.toBytes32()]?.[account.toBytes32()]) {
          return this.balanceCache[chainId][token.toBytes32()][account.toBytes32()];
        }
        const spokePoolClient = this.clients.spokePoolClients[chainId];
        if (isEVMSpokePoolClient(spokePoolClient)) {
          const gasTokenAddressForChain = getNativeTokenAddressForChain(chainId);
          const balance = token.eq(gasTokenAddressForChain)
            ? await spokePoolClient.spokePool.provider.getBalance(account.toEvmAddress())
            : // Use the latest block number the SpokePoolClient is aware of to query balances.
              // This prevents double counting when there are very recent refund leaf executions that the SpokePoolClients
              // missed (the provider node did not see those events yet) but when the balanceOf calls are made, the node
              // is now aware of those executions.
              await new Contract(token.toEvmAddress(), ERC20.abi, spokePoolClient.spokePool.provider).balanceOf(
                account.toEvmAddress(),
                {
                  blockTag: spokePoolClient.latestHeightSearched,
                }
              );
          this.balanceCache[chainId] ??= {};
          this.balanceCache[chainId][token.toBytes32()] ??= {};
          this.balanceCache[chainId][token.toBytes32()][account.toBytes32()] = balance;
          return balance;
        }
        // Assert balance request has solana types.
        assert(isSVMSpokePoolClient(spokePoolClient));
        assert(token.isSVM());
        assert(account.isSVM());
        const provider = spokePoolClient.svmEventsClient.getRpc();
        if (!token.eq(getNativeTokenAddressForChain(chainId))) {
          return getSolanaTokenBalance(provider, token, account);
        } else {
          const balanceInLamports = await provider.getBalance(arch.svm.toAddress(account)).send();
          return toBN(Number(balanceInLamports.value));
        }
      })
    );
  }

  private async _getDecimals(decimalrequests: { chainId: number; token: Address }[]): Promise<number[]> {
    return await Promise.all(
      decimalrequests.map(async ({ chainId, token }) => {
        const gasTokenAddressForChain = getNativeTokenAddressForChain(chainId);
        if (token.eq(gasTokenAddressForChain)) {
          return chainIsEvm(chainId) ? 18 : 9;
        } // Assume all EVM chains have 18 decimal native tokens.
        if (this.decimals[chainId]?.[token.toBytes32()]) {
          return this.decimals[chainId][token.toBytes32()];
        }
        let decimals: number;
        const spokePoolClient = this.clients.spokePoolClients[chainId];
        if (isEVMSpokePoolClient(spokePoolClient)) {
          decimals = await new Contract(token.toEvmAddress(), ERC20.abi, spokePoolClient.spokePool.provider).decimals();
        } else {
          decimals = getTokenInfo(token, chainId).decimals;
        }
        if (!this.decimals[chainId]) {
          this.decimals[chainId] = {};
        }
        if (!this.decimals[chainId][token.toBytes32()]) {
          this.decimals[chainId][token.toBytes32()] = decimals;
        }
        return decimals;
      })
    );
  }

  private _tokenEnabledForNetwork(tokenSymbol: string, networkName: string): boolean {
    for (const [chainId, network] of Object.entries(PUBLIC_NETWORKS)) {
      if (network.name === networkName) {
        return isDefined(TOKEN_SYMBOLS_MAP[tokenSymbol]?.addresses[chainId]);
      }
    }
    return false;
  }

  private _shouldCloseFillPDA(fillStatus: FillStatus, fillDeadline: number, currentTime: number): boolean {
    return fillStatus === FillStatus.Filled && currentTime > fillDeadline;
  }
}

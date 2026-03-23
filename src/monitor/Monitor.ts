import { BundleDataApproxClient } from "../clients";
import { EXPECTED_L1_TO_L2_MESSAGE_TIME } from "../common";
import {
  BundleAction,
  DepositWithBlock,
  FillStatus,
  FillWithBlock,
  L1Token,
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
  parseUnits,
  providers,
  toBN,
  toBNWei,
  winston,
  TOKEN_SYMBOLS_MAP,
  CHAIN_IDs,
  isDefined,
  getRemoteTokenForL1Token,
  getTokenInfo,
  ConvertDecimals,
  getInventoryBalanceContributorTokens,
  getInventoryEquivalentL1TokenAddress,
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
  chainHasNativeToken,
  getLatestRunningBalances,
  RunningBalanceResult,
} from "../utils";
import { MonitorClients, updateMonitorClients } from "./MonitorClientHelper";
import { MonitorConfig } from "./MonitorConfig";
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

type BalanceRequest = { chainId: number; token: Address; account: Address };

export class Monitor {
  // Block range to search is only defined on calling update().
  private hubPoolStartingBlock: number | undefined = undefined;
  private hubPoolEndingBlock: number | undefined = undefined;
  private spokePoolsBlocks: Record<number, { startingBlock: number | undefined; endingBlock: number | undefined }> = {};
  private balanceCache: { [chainId: number]: { [token: string]: { [account: string]: BigNumber } } } = {};
  private decimals: { [chainId: number]: { [token: string]: number } } = {};
  private additionalL1Tokens: L1Token[] = [];
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
    const l1Token = getInventoryEquivalentL1TokenAddress(l2Token, chainId, this.clients.hubPoolClient.chainId);
    const l1TokenDecimals = getTokenInfo(l1Token, this.clients.hubPoolClient.chainId).decimals;
    const l2TokenDecimals = getTokenInfo(l2Token, chainId).decimals;
    return ConvertDecimals(l2TokenDecimals, l1TokenDecimals);
  }

  async reportRelayerBalances(): Promise<void> {
    const hubChainId = this.clients.hubPoolClient.chainId;
    const relayers = this.monitorConfig.monitoredRelayers;
    const allL1Tokens = [...this.l1Tokens, ...this.additionalL1Tokens];

    // Fetch pending rebalances once for all relayers.
    let pendingRebalances: { [chainId: number]: { [token: string]: BigNumber } } = {};
    if (isDefined(this.clients.rebalancerClient)) {
      try {
        pendingRebalances = await this.clients.rebalancerClient.getPendingRebalances();
      } catch (error) {
        this.logger.warn({
          at: "Monitor#reportRelayerBalances",
          message: "Unable to fetch pending rebalances; defaulting to zero",
          error,
        });
      }
    }

    for (const relayer of relayers) {
      // Fetch pending L2 withdrawals for this relayer across all L1 tokens in parallel.
      const pendingL2Withdrawals: { [l1Token: string]: { [chainId: number]: BigNumber } } = {};
      await Promise.all(
        allL1Tokens.map(async (l1Token) => {
          try {
            pendingL2Withdrawals[l1Token.address.toNative()] =
              await this.clients.crossChainTransferClient.adapterManager.getTotalPendingWithdrawalAmount(
                this.crossChainAdapterSupportedChains,
                relayer,
                l1Token.address
              );
          } catch {
            pendingL2Withdrawals[l1Token.address.toNative()] = {};
          }
        })
      );

      let mrkdwn = "Token amounts: current, pending, total\n";

      for (const l1Token of allL1Tokens) {
        const l1TokenDecimals = l1Token.decimals;
        const formatWei = createFormatFunction(2, 4, false, l1TokenDecimals);
        let tokenMrkdwn = `*[${l1Token.symbol}]*\n`;
        let tokenTotal = bnZero;

        for (const chainId of this.monitorChains) {
          if (!relayer.isValidOn(chainId)) {
            continue;
          }

          const l2Tokens = getInventoryBalanceContributorTokens(l1Token.address, chainId, hubChainId);
          if (l2Tokens.length === 0) {
            continue;
          }

          // Batch-fetch balances for all L2 tokens on this chain.
          const balanceRequests: BalanceRequest[] = l2Tokens.map((l2Token) => ({
            chainId,
            token: l2Token,
            account: relayer,
          }));
          const rawBalances = await this._getBalances(balanceRequests);

          for (let i = 0; i < l2Tokens.length; i++) {
            const l2Token = l2Tokens[i];
            const { symbol: l2Symbol, decimals: l2Decimals } = getTokenInfo(l2Token, chainId);
            const toL1Decimals = ConvertDecimals(l2Decimals, l1TokenDecimals);

            // Current balance (converted to L1 decimals).
            const currentBalance = toL1Decimals(rawBalances[i]);

            // Pending: cross-chain transfers + pending L2 withdrawals (hub chain only) + pending swap rebalances.
            let pending = this.clients.crossChainTransferClient.getOutstandingCrossChainTransferAmount(
              relayer,
              chainId,
              l1Token.address,
              l2Token
            );

            if (chainId === hubChainId) {
              const withdrawals = pendingL2Withdrawals[l1Token.address.toNative()] ?? {};
              const totalWithdrawals = Object.values(withdrawals).reduce((acc, amt) => acc.add(amt), bnZero);
              pending = pending.add(totalWithdrawals);
            }

            const pendingRebalanceAmount = pendingRebalances[chainId]?.[l1Token.symbol];
            if (isDefined(pendingRebalanceAmount) && !pendingRebalanceAmount.isZero()) {
              const remoteToken = getRemoteTokenForL1Token(l1Token.address, chainId, hubChainId);
              if (isDefined(remoteToken)) {
                const remoteDecimals = getTokenInfo(remoteToken, chainId).decimals;
                pending = pending.add(ConvertDecimals(remoteDecimals, l1TokenDecimals)(pendingRebalanceAmount));
              }
            }

            const totalBalance = currentBalance.add(pending);
            tokenTotal = tokenTotal.add(totalBalance);

            tokenMrkdwn += `${getNetworkName(chainId)} | ${l2Symbol} | ${formatWei(currentBalance.toString())} | ${formatWei(pending.toString())} | ${formatWei(totalBalance.toString())}\n`;

            // Machine-readable debug log.
            this.logger.debug({
              at: "Monitor#reportRelayerBalances",
              message: "Machine-readable single balance report",
              relayer: relayer.toNative(),
              l1TokenSymbol: l1Token.symbol,
              l2TokenSymbol: l2Symbol,
              chainId,
              decimals: l1TokenDecimals,
              currentBalanceInWei: currentBalance.toString(),
              pendingInWei: pending.toString(),
              totalBalanceInWei: totalBalance.toString(),
              datadog: true,
            });
          }

          // Upcoming refund row per chain (one per chain, not per L2 token).
          const upcomingRefunds = this.bundleDataApproxClient.getUpcomingRefunds(chainId, l1Token.address, relayer);
          if (upcomingRefunds.gt(0)) {
            const remoteToken = getRemoteTokenForL1Token(l1Token.address, chainId, hubChainId);
            const refundInL1 = isDefined(remoteToken)
              ? ConvertDecimals(getTokenInfo(remoteToken, chainId).decimals, l1TokenDecimals)(upcomingRefunds)
              : upcomingRefunds;
            tokenTotal = tokenTotal.add(refundInL1);
            tokenMrkdwn += `${getNetworkName(chainId)} | refunds | - | - | ${formatWei(refundInL1.toString())}\n`;
          }
        }

        tokenMrkdwn += `*Total* | | | | ${formatWei(tokenTotal.toString())}\n`;
        mrkdwn += tokenMrkdwn;
      }

      this.logger.info({
        at: "Monitor#reportRelayerBalances",
        message: `Balance report for ${relayer}`,
        mrkdwn,
      });
    }
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

  async reportSpokePoolRunningBalances(): Promise<void> {
    const chainIds =
      this.monitorConfig.monitoredSpokePoolChains.length !== 0
        ? this.monitorChains.filter((chain) => this.monitorConfig.monitoredSpokePoolChains.includes(chain))
        : this.monitorChains;

    let mrkdwn = "Running balance estimates: last validated, -deposits, +refunds, running balance, bundle end block\n";

    for (const l1Token of this.l1Tokens) {
      const formatWei = createFormatFunction(1, 4, false, l1Token.decimals);
      let results: { [chainId: number]: RunningBalanceResult };
      try {
        results = await getLatestRunningBalances(l1Token.address, chainIds, this.clients.hubPoolClient, this.bundleDataApproxClient);
      } catch (error) {
        this.logger.debug({
          at: "Monitor#reportSpokePoolRunningBalances",
          message: `Skipping running balances for ${l1Token.symbol}`,
          error,
        });
        continue;
      }

      mrkdwn += `*[${l1Token.symbol}]*\n`;
      for (const chainId of chainIds) {
        const r = results[chainId];
        if (!r) {
          continue;
        }
        mrkdwn +=
          `${getNetworkName(chainId)}: ` +
          `${formatWei(r.lastValidatedRunningBalance.toString())}, ` +
          `-${formatWei(r.upcomingDeposits.toString())}, ` +
          `+${formatWei(r.upcomingRefunds.toString())}, ` +
          `${formatWei(r.absLatestRunningBalance.toString())}, ` +
          `${r.bundleEndBlock}\n`;
      }
    }

    this.logger.info({
      at: "Monitor#reportSpokePoolRunningBalances",
      message: "Spoke pool running balance report",
      mrkdwn,
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

  getTotalTransferAmount(transfers: TokenTransfer[]): BigNumber {
    return transfers.map((transfer) => transfer.value).reduce((a, b) => a.add(b));
  }

  protected getRemoteTokenForL1Token(l1Token: EvmAddress, chainId: number | string): Address | undefined {
    return chainId === this.clients.hubPoolClient.chainId
      ? l1Token
      : getRemoteTokenForL1Token(l1Token, chainId, this.clients.hubPoolClient.chainId);
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
          const balance =
            token.eq(gasTokenAddressForChain) && chainHasNativeToken(chainId)
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

  private _shouldCloseFillPDA(fillStatus: FillStatus, fillDeadline: number, currentTime: number): boolean {
    return fillStatus === FillStatus.Filled && currentTime > fillDeadline;
  }
}

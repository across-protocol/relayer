import { BalanceAllocator } from "../clients";
import { EXPECTED_L1_TO_L2_MESSAGE_TIME, spokePoolClientsToProviders } from "../common";
import {
  BalanceType,
  BundleAction,
  DepositWithBlock,
  FillStatus,
  L1Token,
  RelayerBalanceReport,
  RelayerBalanceTable,
  TokenTransfer,
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
  WETH9,
  CHAIN_IDs,
  runTransaction,
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
} from "../utils";
import { MonitorClients, updateMonitorClients } from "./MonitorClientHelper";
import { MonitorConfig } from "./MonitorConfig";
import { CombinedRefunds, getImpliedBundleBlockRanges } from "../dataworker/DataworkerUtils";
import { PUBLIC_NETWORKS, TOKEN_EQUIVALENCE_REMAPPING } from "@across-protocol/constants";
import { utils as sdkUtils } from "@across-protocol/sdk";

// 60 minutes, which is the length of the challenge window, so if a rebalance takes longer than this to finalize,
// then its finalizing after the subsequent challenge period has started, which is sub-optimal.
export const REBALANCE_FINALIZE_GRACE_PERIOD = Number(process.env.REBALANCE_FINALIZE_GRACE_PERIOD ?? 60 * 60);

// bundle frequency.
export const ALL_CHAINS_NAME = "All chains";
const ALL_BALANCE_TYPES = [
  BalanceType.CURRENT,
  BalanceType.PENDING,
  BalanceType.NEXT,
  BalanceType.PENDING_TRANSFERS,
  BalanceType.TOTAL,
];

type BalanceRequest = { chainId: number; token: Address; account: Address };

export class Monitor {
  // Block range to search is only defined on calling update().
  private hubPoolStartingBlock: number | undefined = undefined;
  private hubPoolEndingBlock: number | undefined = undefined;
  private spokePoolsBlocks: Record<number, { startingBlock: number | undefined; endingBlock: number | undefined }> = {};
  private balanceCache: { [chainId: number]: { [token: string]: { [account: string]: BigNumber } } } = {};
  private decimals: { [chainId: number]: { [token: string]: number } } = {};
  private additionalL1Tokens: string[] = [];
  private balanceAllocator: BalanceAllocator;
  // Chains for each spoke pool client.
  public monitorChains: number[];
  // Chains that we care about inventory manager activity on, so doesn't include Ethereum which doesn't
  // have an inventory manager adapter.
  public crossChainAdapterSupportedChains: number[];

  public constructor(
    readonly logger: winston.Logger,
    readonly monitorConfig: MonitorConfig,
    readonly clients: MonitorClients
  ) {
    this.crossChainAdapterSupportedChains = clients.crossChainTransferClient.adapterManager.supportedChains();
    this.monitorChains = Object.values(clients.spokePoolClients)
      .map(({ chainId }) => chainId)
      .filter(chainIsEvm);
    for (const chainId of this.monitorChains) {
      this.spokePoolsBlocks[chainId] = { startingBlock: undefined, endingBlock: undefined };
    }
    logger.debug({
      at: "Monitor#constructor",
      message: "Initialized monitor",
      monitorChains: this.monitorChains,
      crossChainAdapterSupportedChains: this.crossChainAdapterSupportedChains,
    });
    this.balanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(clients.spokePoolClients));
    this.additionalL1Tokens = this.monitorConfig.additionalL1NonLpTokens;
  }

  public async update(): Promise<void> {
    // Clear balance cache at the start of each update.
    // Note: decimals don't need to be cleared because they shouldn't ever change.
    this.balanceCache = {};
    await updateMonitorClients(this.clients);
    await this.computeHubPoolBlocks();
    await this.computeSpokePoolsBlocks();

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
    const { hubPoolClient } = this.clients;
    const l1Tokens = hubPoolClient.getL1Tokens().map(({ address }) => address);
    const tokensPerChain = Object.fromEntries(
      this.monitorChains.map((chainId) => {
        const l2Tokens = l1Tokens.map((l1Token) => this.getRemoteTokenForL1Token(l1Token, chainId)).filter(isDefined);
        return [chainId, l2Tokens];
      })
    );
    await this.clients.tokenTransferClient.update(searchConfigs, tokensPerChain);
  }

  async checkUtilization(): Promise<void> {
    this.logger.debug({ at: "Monitor#checkUtilization", message: "Checking for pool utilization ratio" });
    const l1Tokens = this.clients.hubPoolClient.getL1Tokens();
    const l1TokenUtilizations = await Promise.all(
      l1Tokens.map(async (l1Token) => {
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
          ${createFormatFunction(0, 2)(utilizationString)}% utilization!"`;
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

  async reportUnfilledDeposits(): Promise<void> {
    const { hubPoolClient, spokePoolClients } = this.clients;
    const unfilledDeposits: Record<number, DepositWithBlock[]> = Object.fromEntries(
      await mapAsync(Object.values(spokePoolClients), async ({ chainId: destinationChainId }) => {
        const deposits = getUnfilledDeposits(destinationChainId, spokePoolClients, hubPoolClient).map(
          ({ deposit, invalidFills: invalid }) => {
            // Ignore depositId >= bnUInt32Max; these tend to be pre-fills that are eventually valid and
            // tend to confuse this reporting because there are multiple deposits with the same depositId.
            if (deposit.depositId < bnUint32Max && invalid.length > 0) {
              const invalidFills = Object.fromEntries(
                invalid.map(({ relayer, destinationChainId, depositId, txnRef }) => {
                  return [relayer, { destinationChainId, depositId, txnRef }];
                })
              );
              this.logger.warn({
                at: "SpokePoolClient",
                chainId: destinationChainId,
                message: `Invalid fills found matching ${getNetworkName(deposit.originChainId)} deposit.`,
                deposit,
                invalidFills,
                notificationPath: "across-invalid-fills",
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

  // @dev This is a temporary function to report invalid fills related to SVM deposits. It will be removed once
  // we gain enough confidence that the SVM fills are working correctly.
  async reportInvalidFillsRelatedToSvm(): Promise<void> {
    const { spokePoolClients } = this.clients;
    const svmClient = spokePoolClients[CHAIN_IDs.SOLANA];
    const svmDeposits = svmClient.getDeposits();

    this.logger.debug({
      at: "Monitor#reportInvalidFillsRelatedToSvm",
      message: "Checking for invalid fills related to SVM deposits",
      svmDeposits: svmDeposits.length,
    });

    // Check for invalid fills related to svm deposits.
    await mapAsync(
      svmDeposits.filter(({ destinationChainId }) => destinationChainId !== CHAIN_IDs.SOLANA),
      async (deposit) => {
        const { destinationChainId, depositId, originChainId } = deposit;
        const destinationClient = spokePoolClients[destinationChainId];
        if (!destinationClient) {
          return;
        }
        const { invalidFills: invalid } = destinationClient.getValidUnfilledAmountForDeposit(deposit);
        if (depositId < bnUint32Max && invalid.length > 0) {
          const invalidFills = Object.fromEntries(
            invalid.map(({ relayer, destinationChainId, depositId, txnRef }) => {
              return [relayer, { destinationChainId, depositId, txnRef }];
            })
          );
          this.logger.warn({
            at: "Monitor##reportInvalidFillsRelatedToSvm",
            destinationChainId,
            message: `Invalid ${invalid.length} fills found matching SVM ${getNetworkName(originChainId)} deposit.`,
            deposit,
            invalidFills,
            notificationPath: "across-invalid-fills",
          });
        }
      }
    );

    this.logger.debug({
      at: "Monitor#reportInvalidFillsRelatedToSvm",
      message: "Checking for invalid SVM fills related to EVM deposits",
      svmFills: svmClient.getFills().length,
    });

    // Check for invalid SVM fills related to EVM deposits.
    svmClient.getFills().map((fill) => {
      const { originChainId, destinationChainId } = fill;
      const originClient = spokePoolClients[originChainId];
      if (!originClient) {
        return;
      }
      const deposit = originClient.getDepositForFill(fill);
      if (!deposit) {
        this.logger.warn({
          at: "Monitor##reportInvalidFillsRelatedToSvm",
          originChainId,
          message: `Invalid SVM fill found with no matching deposit for origin chain ${getNetworkName(originChainId)}.`,
          fill,
          notificationPath: "across-invalid-fills",
        });
        return;
      }
      const { invalidFills: invalid } = svmClient.getValidUnfilledAmountForDeposit(deposit);
      if (deposit.depositId < bnUint32Max && invalid.length > 0) {
        const invalidFills = Object.fromEntries(
          invalid.map(({ relayer, destinationChainId, depositId, txnRef }) => {
            return [relayer, { destinationChainId, depositId, txnRef }];
          })
        );
        this.logger.warn({
          at: "Reporter#reportInvalidFillsRelatedToSvm",
          destinationChainId,
          message: `Found ${invalidFills.length} invalid SVM fills found matching ${getNetworkName(
            originChainId
          )} deposit.`,
          deposit,
          invalidFills,
          notificationPath: "across-invalid-fills",
        });
      }
    });
  }

  l2TokenAmountToL1TokenAmountConverter(l2Token: Address, chainId: number): (BigNumber) => BigNumber {
    // Step 1: Get l1 token address equivalent of L2 token
    const l1Token = getL1TokenAddress(l2Token, chainId);
    const l1TokenDecimals = getTokenInfo(l1Token, this.clients.hubPoolClient.chainId).decimals;
    const l2TokenDecimals = getTokenInfo(l2Token, chainId).decimals;
    return ConvertDecimals(l2TokenDecimals, l1TokenDecimals);
  }

  getL1TokensForRelayerBalancesReport(): L1Token[] {
    const additionalL1Tokens = this.additionalL1Tokens.map((l1Token) => {
      const l1TokenInfo = getTokenInfo(EvmAddress.from(l1Token), this.clients.hubPoolClient.chainId);
      assert(l1TokenInfo.address.isEVM());
      return {
        ...l1TokenInfo,
        address: l1TokenInfo.address,
      };
    });
    const allL1Tokens = [...this.clients.hubPoolClient.getL1Tokens(), ...additionalL1Tokens].map(
      ({ symbol, ...tokenInfo }) => {
        return {
          ...tokenInfo,
          // Remap symbols so that we're using a symbol available to us in TOKEN_SYMBOLS_MAP.
          symbol: TOKEN_EQUIVALENCE_REMAPPING[symbol] ?? symbol,
        };
      }
    );
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

    // @dev TODO: Handle special case for tokens that do not have an L1 token mapped to them via PoolRebalanceRoutes
    const chainIds = this.monitorChains;
    const allChainNames = chainIds.map(getNetworkName).concat([ALL_CHAINS_NAME]);
    const reports = this.initializeBalanceReports(relayers, allL1Tokens, allChainNames);

    await this.updateCurrentRelayerBalances(reports);
    await this.updateLatestAndFutureRelayerRefunds(reports);

    for (const relayer of relayers) {
      const report = reports[relayer.toBytes32()];
      let summaryMrkdwn = "*[Summary]*\n";
      let mrkdwn = "Token amounts: current, pending execution, future, cross-chain transfers, total\n";
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

      mrkdwn += summaryMrkdwn;
      this.logger.info({
        at: "Monitor#reportRelayerBalances",
        message: `Balance report for ${relayer} 📖`,
        mrkdwn,
      });
    }
    Object.entries(reports).forEach(([relayer, balanceTable]) => {
      Object.entries(balanceTable).forEach(([tokenSymbol, columns]) => {
        const decimals = allL1Tokens.find((token) => token.symbol === tokenSymbol)?.decimals;
        if (!decimals) {
          throw new Error(`No decimals found for ${tokenSymbol}`);
        }
        Object.entries(columns).forEach(([chainName, cell]) => {
          if (this._tokenEnabledForNetwork(tokenSymbol, chainName)) {
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
    for (const relayer of this.monitorConfig.monitoredRelayers) {
      for (const chainId of this.monitorChains) {
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
            relayerBalanceReport[relayer.toBytes32()],
            symbol,
            getNetworkName(chainId),
            BalanceType.CURRENT,
            decimalConverter(tokenBalances[i])
          );
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
              const gasTokenAddressForChain = getNativeTokenAddressForChain(chainId);
              let symbol;
              if (gasTokenAddressForChain) {
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
      wdQuota,
    });
  }

  /**
   * @notice Checks if any accounts on refill balances list are under their ETH target, if so tries to refill them.
   * This functionality compliments the report-only mode of `checkBalances`. Its expected that some accounts are
   * listed in `monitorBalances`. These accounts might also be listed in `refillBalances` with a higher target than
   * the `monitorBalances` target. This function will ensure that `checkBalances` will rarely alert for those
   * balances.
   */
  async refillBalances(): Promise<void> {
    const { refillEnabledBalances } = this.monitorConfig;

    // Check for current balances.
    const currentBalances = await this._getBalances(refillEnabledBalances);
    const decimalValues = await this._getDecimals(refillEnabledBalances);
    this.logger.debug({
      at: "Monitor#refillBalances",
      message: "Checking balances for refilling",
      currentBalances: refillEnabledBalances.map(({ chainId, token, account, target }, i) => {
        return {
          chainId,
          token: token.toEvmAddress(),
          account: account.toEvmAddress(),
          currentBalance: currentBalances[i].toString(),
          target: parseUnits(target.toString(), decimalValues[i]),
        };
      }),
    });

    // Compare current balances with triggers and send tokens if signer has enough balance.
    const signerAddress = await this.clients.hubPoolClient.hubPool.signer.getAddress();
    const promises = await Promise.allSettled(
      refillEnabledBalances.map(async ({ chainId, isHubPool, token, account, target, trigger }, i) => {
        const currentBalance = currentBalances[i];
        const decimals = decimalValues[i];
        const balanceTrigger = parseUnits(trigger.toString(), decimals);
        const isBelowTrigger = currentBalance.lte(balanceTrigger);
        if (isBelowTrigger) {
          // Fill balance back to target, not trigger.
          const balanceTarget = parseUnits(target.toString(), decimals);
          const deficit = balanceTarget.sub(currentBalance);
          let canRefill = await this.balanceAllocator.requestBalanceAllocation(
            chainId,
            [token],
            toAddressType(signerAddress, chainId),
            deficit
          );
          const spokePoolClient = this.clients.spokePoolClients[chainId];
          // If token is gas token, try unwrapping deficit amount of WETH into ETH to have available for refill.
          if (
            !canRefill &&
            token.eq(getNativeTokenAddressForChain(chainId)) &&
            getNativeTokenSymbol(chainId) === "ETH" &&
            isEVMSpokePoolClient(spokePoolClient)
          ) {
            const weth = new Contract(
              TOKEN_SYMBOLS_MAP.WETH.addresses[chainId],
              WETH9.abi,
              spokePoolClient.spokePool.signer
            );
            const wethBalance = await weth.balanceOf(signerAddress);
            if (wethBalance.gte(deficit)) {
              const txn = await (await runTransaction(this.logger, weth, "withdraw", [deficit])).wait();
              this.logger.info({
                at: "Monitor#refillBalances",
                message: `Unwrapped WETH from ${signerAddress} to refill ETH in ${account} 🎁!`,
                chainId,
                requiredUnwrapAmount: deficit.toString(),
                wethBalance,
                wethAddress: weth.address,
                ethBalance: currentBalance.toString(),
                transactionHash: blockExplorerLink(txn.transactionHash, chainId),
              });
              canRefill = true;
            } else {
              this.logger.warn({
                at: "Monitor#refillBalances",
                message: `Trying to unwrap WETH balance from ${signerAddress} to use for refilling ETH in ${account} but not enough WETH to unwrap`,
                chainId,
                requiredUnwrapAmount: deficit.toString(),
                wethBalance,
                wethAddress: weth.address,
                ethBalance: currentBalance.toString(),
              });
              return;
            }
          }
          if (canRefill && isEVMSpokePoolClient(spokePoolClient)) {
            this.logger.debug({
              at: "Monitor#refillBalances",
              message: "Balance below trigger and can refill to target",
              from: signerAddress,
              to: account.toEvmAddress(),
              balanceTrigger,
              balanceTarget,
              deficit,
              token: token.toEvmAddress(),
              chainId,
              isHubPool,
            });
            // There are three cases:
            // 1. The account is the HubPool. In which case we need to call a special function to load ETH into it.
            // 2. The account is not a HubPool and we want to load ETH.
            if (isHubPool) {
              // Note: We ignore the `token` if the account is HubPool because we can't call the method with other tokens.
              this.clients.multiCallerClient.enqueueTransaction({
                contract: this.clients.hubPoolClient.hubPool,
                chainId: this.clients.hubPoolClient.chainId,
                method: "loadEthForL2Calls",
                args: [],
                message: "Reloaded ETH in HubPool 🫡!",
                mrkdwn: `Loaded ${formatUnits(deficit, decimals)} ETH from ${signerAddress}.`,
                value: deficit,
              });
            } else {
              const nativeSymbolForChain = getNativeTokenSymbol(chainId);
              // To send a raw transaction, we need to create a fake Contract instance at the recipient address and
              // set the method param to be an empty string.
              const sendRawTransactionContract = new Contract(
                account.toEvmAddress(),
                [],
                spokePoolClient.spokePool.signer
              );
              const txn = await (await runTransaction(this.logger, sendRawTransactionContract, "", [], deficit)).wait();
              this.logger.info({
                at: "Monitor#refillBalances",
                message: `Reloaded ${formatUnits(
                  deficit,
                  decimals
                )} ${nativeSymbolForChain} for ${account} from ${signerAddress} 🫡!`,
                transactionHash: blockExplorerLink(txn.transactionHash, chainId),
              });
            }
          } else {
            this.logger.warn({
              at: "Monitor#refillBalances",
              message: "Cannot refill balance to target",
              from: signerAddress,
              to: account,
              balanceTrigger,
              balanceTarget,
              deficit,
              token,
              chainId,
            });
          }
        } else {
          this.logger.debug({
            at: "Monitor#refillBalances",
            message: "Balance is above trigger",
            account,
            balanceTrigger,
            currentBalance: currentBalance.toString(),
            token,
            chainId,
          });
        }
      })
    );
    const rejections = promises.filter((promise) => promise.status === "rejected");
    if (rejections.length > 0) {
      this.logger.warn({
        at: "Monitor#refillBalances",
        message: "Some refill transactions rejected for unknown reasons",
        rejections,
      });
    }
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
    // If there is an outstanding root bundle, then add it to the bundles to check. Otherwise, ignore it.
    const bundlesToCheck = validatedBundles.map((validatedBundle) => validatedBundle.txnRef).includes(bundle.txnRef)
      ? validatedBundles
      : [...validatedBundles, bundle];

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
    const [
      poolRebalanceRoot,
      currentBundleData,
      accountedBundleRefunds,
      unaccountedBundleRefunds,
      currentSpokeBalances,
    ] = await Promise.all([
      this.clients.bundleDataClient.loadData(lastProposedBundleBlockRanges, this.clients.spokePoolClients, true),
      this.clients.bundleDataClient.loadData(slowFillBlockRange, this.clients.spokePoolClients, true),
      mapAsync(bundlesToCheck, async (proposedBundle) =>
        this.clients.bundleDataClient.getPendingRefundsFromBundle(proposedBundle)
      ),
      this.clients.bundleDataClient.getApproximateRefundsForBlockRange(enabledChainIds, blockRangeTail),
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

    const poolRebalanceLeaves = _buildPoolRebalanceRoot(
      lastProposedBundleBlockRanges[0][1],
      lastProposedBundleBlockRanges[0][1],
      poolRebalanceRoot.bundleDepositsV3,
      poolRebalanceRoot.bundleFillsV3,
      poolRebalanceRoot.bundleSlowFillsV3,
      poolRebalanceRoot.unexecutableSlowFills,
      poolRebalanceRoot.expiredDepositsToRefundV3,
      this.clients
    ).leaves;

    // Get the pool rebalance leaf amounts.
    const enabledTokens = [...hubPoolClient.getL1Tokens()];
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
      const l2TokenAddresses = monitoredTokenSymbols
        .map((symbol) => l2TokenForChain(chainId, symbol))
        .filter(isDefined);
      pendingRelayerRefunds[chainId] = {};
      l2TokenAddresses.forEach((l2Token) => {
        const pendingValidatedDeductions = accountedBundleRefunds
          .map((refund) => refund[chainId]?.[l2Token.toBytes32()])
          .filter(isDefined)
          .reduce(
            (totalPendingRefunds, refunds) =>
              Object.values(refunds).reduce(
                (totalBundleRefunds, bundleRefund) => totalBundleRefunds.add(bundleRefund),
                bnZero
              ),
            bnZero
          );
        const nextBundleDeductions = [unaccountedBundleRefunds]
          .map((refund) => refund[chainId]?.[l2Token.toBytes32()])
          .filter(isDefined)
          .reduce(
            (totalPendingRefunds, refunds) =>
              Object.values(refunds).reduce(
                (totalBundleRefunds, bundleRefund) => totalBundleRefunds.add(bundleRefund),
                bnZero
              ),
            bnZero
          );
        pendingRelayerRefunds[chainId][l2Token.toNative()] = pendingValidatedDeductions.add(nextBundleDeductions);
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

    const allL1Tokens = this.clients.hubPoolClient.getL1Tokens();
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

  async updateLatestAndFutureRelayerRefunds(relayerBalanceReport: RelayerBalanceReport): Promise<void> {
    const validatedBundleRefunds: CombinedRefunds[] =
      await this.clients.bundleDataClient.getPendingRefundsFromValidBundles();
    const nextBundleRefunds = await this.clients.bundleDataClient.getNextBundleRefunds();

    // Calculate which fills have not yet been refunded for each monitored relayer.
    for (const refunds of validatedBundleRefunds) {
      for (const relayer of this.monitorConfig.monitoredRelayers) {
        this.updateRelayerRefunds(refunds, relayerBalanceReport[relayer.toBytes32()], relayer, BalanceType.PENDING);
      }
    }
    for (const refunds of nextBundleRefunds) {
      for (const relayer of this.monitorConfig.monitoredRelayers) {
        this.updateRelayerRefunds(refunds, relayerBalanceReport[relayer.toBytes32()], relayer, BalanceType.NEXT);
      }
    }
    for (const relayer of this.monitorConfig.monitoredRelayers) {
      this.updateCrossChainTransfers(relayer, relayerBalanceReport[relayer.toBytes32()]);
    }
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

  getTotalTransferAmount(transfers: TokenTransfer[]): BigNumber {
    return transfers.map((transfer) => transfer.value).reduce((a, b) => a.add(b));
  }

  initializeBalanceReports(relayers: Address[], allL1Tokens: L1Token[], allChainNames: string[]): RelayerBalanceReport {
    const reports: RelayerBalanceReport = {};
    for (const relayer of relayers) {
      reports[relayer.toBytes32()] = {};
      for (const token of allL1Tokens) {
        reports[relayer.toBytes32()][token.symbol] = {};
        for (const chainName of allChainNames) {
          reports[relayer.toBytes32()][token.symbol][chainName] = {};
          for (const balanceType of ALL_BALANCE_TYPES) {
            reports[relayer.toBytes32()][token.symbol][chainName][balanceType] = bnZero;
          }
        }
      }
    }
    return reports;
  }

  private updateRelayerRefunds(
    fillsToRefundPerChain: CombinedRefunds,
    relayerBalanceTable: RelayerBalanceTable,
    relayer: Address,
    balanceType: BalanceType
  ) {
    const l1Tokens = this.getL1TokensForRelayerBalancesReport();
    for (const chainId of this.monitorChains) {
      const l2ToL1Tokens = this.getL2ToL1TokenMap(l1Tokens, chainId);
      const fillsToRefund = fillsToRefundPerChain[chainId];
      // Skip chains that don't have any refunds.
      if (fillsToRefund === undefined) {
        continue;
      }

      for (const _tokenAddress of Object.keys(fillsToRefund)) {
        const tokenAddress = toAddressType(_tokenAddress, chainId);
        const decimalConverter = this.l2TokenAmountToL1TokenAmountConverter(tokenAddress, chainId);
        // Skip token if there are no refunds (although there are valid fills).
        // This is an edge case that shouldn't usually happen.
        if (
          fillsToRefund[tokenAddress.toBytes32()] === undefined ||
          l2ToL1Tokens[tokenAddress.toNative()] === undefined
        ) {
          continue;
        }

        const totalRefundAmount = fillsToRefund[tokenAddress.toBytes32()][relayer.toBytes32()];
        const { symbol } = l2ToL1Tokens[tokenAddress.toNative()];
        const amount = decimalConverter(totalRefundAmount ?? bnZero);
        this.updateRelayerBalanceTable(relayerBalanceTable, symbol, getNetworkName(chainId), balanceType, amount);
      }
    }
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
        const latestSlot = Number(await spokePoolClient.svmEventsClient.getRpc().getSlot().send());
        const endingBlock = this.monitorConfig.spokePoolsBlocks[chainId]?.endingBlock;
        this.monitorConfig.spokePoolsBlocks[chainId] ??= { startingBlock: undefined, endingBlock: undefined };
        if (this.monitorConfig.pollingDelay === 0) {
          this.monitorConfig.spokePoolsBlocks[chainId].startingBlock ??= latestSlot;
        } else {
          this.monitorConfig.spokePoolsBlocks[chainId].startingBlock = endingBlock;
        }
        this.monitorConfig.spokePoolsBlocks[chainId].endingBlock = latestSlot;
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
        // @todo _getBalances is unimplemented for SVM.
        return bnZero;
      })
    );
  }

  private async _getDecimals(decimalrequests: { chainId: number; token: Address }[]): Promise<number[]> {
    return await Promise.all(
      decimalrequests.map(async ({ chainId, token }) => {
        const gasTokenAddressForChain = getNativeTokenAddressForChain(chainId);
        if (token.eq(gasTokenAddressForChain)) {
          return 18;
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
}

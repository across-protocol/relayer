import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import { BalanceAllocator } from "../clients";
import { spokePoolClientsToProviders } from "../common";
import {
  BalanceType,
  BundleAction,
  FillsToRefund,
  L1Token,
  RelayerBalanceReport,
  RelayerBalanceTable,
  TokenTransfer,
  TransfersByChain,
  TransfersByTokens,
} from "../interfaces";
import {
  assign,
  BigNumber,
  bnZero,
  Contract,
  convertFromWei,
  createFormatFunction,
  ERC20,
  ethers,
  blockExplorerLink,
  blockExplorerLinks,
  getEthAddressForChain,
  getGasPrice,
  getNativeTokenSymbol,
  getNetworkName,
  getUnfilledDeposits,
  providers,
  toBN,
  toBNWei,
  winston,
} from "../utils";

import { MonitorClients, updateMonitorClients } from "./MonitorClientHelper";
import { MonitorConfig } from "./MonitorConfig";

export const REBALANCE_FINALIZE_GRACE_PERIOD = 60 * 60 * 4; // 4 hours.
export const ALL_CHAINS_NAME = "All chains";
export const UNKNOWN_TRANSFERS_NAME = "Unknown transfers (incoming, outgoing, net)";
const ALL_BALANCE_TYPES = [
  BalanceType.CURRENT,
  BalanceType.PENDING,
  BalanceType.NEXT,
  BalanceType.PENDING_TRANSFERS,
  BalanceType.TOTAL,
];

interface CategorizedTransfers {
  all: TokenTransfer[];
  bond: TokenTransfer[];
  v1: TokenTransfer[];
  other: TokenTransfer[];
}

type BalanceRequest = { chainId: number; token: string; account: string };

export class Monitor {
  // Block range to search is only defined on calling update().
  private hubPoolStartingBlock: number | undefined = undefined;
  private hubPoolEndingBlock: number | undefined = undefined;
  private spokePoolsBlocks: Record<number, { startingBlock: number | undefined; endingBlock: number | undefined }> = {};
  private balanceCache: { [chainId: number]: { [token: string]: { [account: string]: BigNumber } } } = {};
  private decimals: { [chainId: number]: { [token: string]: number } } = {};
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
    this.balanceAllocator = new BalanceAllocator(spokePoolClientsToProviders(clients.spokePoolClients));
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
          fromBlock: config.startingBlock,
          toBlock: config.endingBlock,
          maxBlockLookBack: 0,
        },
      ])
    );
    const { hubPoolClient } = this.clients;
    const l1Tokens = hubPoolClient.getL1Tokens().map(({ address }) => address);
    const tokensPerChain = Object.fromEntries(
      this.monitorChains.map((chainId) => {
        const l2Tokens = l1Tokens
          .filter((l1Token) => hubPoolClient.l2TokenEnabledForL1Token(l1Token, chainId))
          .map((l1Token) => {
            const l2Token = hubPoolClient.getL2TokenForL1TokenAtBlock(l1Token, chainId);
            return l2Token;
          });
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
          ${blockExplorerLink(l1TokenUtilization.l1Token, l1TokenUtilization.chainId)} on \
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
    const cancelledBundles = this.clients.hubPoolClient.getCancelledRootBundlesInBlockRange(
      this.hubPoolStartingBlock,
      this.hubPoolEndingBlock
    );
    const disputedBundles = this.clients.hubPoolClient.getDisputedRootBundlesInBlockRange(
      this.hubPoolStartingBlock,
      this.hubPoolEndingBlock
    );

    for (const event of proposedBundles) {
      this.notifyIfUnknownCaller(event.proposer, BundleAction.PROPOSED, event.transactionHash);
    }
    for (const event of cancelledBundles) {
      this.notifyIfUnknownCaller(event.disputer, BundleAction.CANCELED, event.transactionHash);
    }
    for (const event of disputedBundles) {
      this.notifyIfUnknownCaller(event.disputer, BundleAction.DISPUTED, event.transactionHash);
    }
  }

  async checkUnknownRelayers(): Promise<void> {
    const chainIds = this.monitorChains;
    this.logger.debug({ at: "Monitor#checkUnknownRelayers", message: "Checking for unknown relayers", chainIds });
    for (const chainId of chainIds) {
      const fills = this.clients.spokePoolClients[chainId].getFillsWithBlockInRange(
        this.spokePoolsBlocks[chainId].startingBlock,
        this.spokePoolsBlocks[chainId].endingBlock
      );
      for (const fill of fills) {
        // Skip notifications for known relay caller addresses, or slow fills.
        const isSlowRelay = sdkUtils.isSlowFill(fill);
        if (this.monitorConfig.whitelistedRelayers.includes(fill.relayer) || isSlowRelay) {
          continue;
        }

        const mrkdwn =
          `An unknown relayer ${blockExplorerLink(fill.relayer, chainId)}` +
          ` filled a deposit on ${getNetworkName(chainId)}\ntx: ${blockExplorerLink(fill.transactionHash, chainId)}`;
        this.logger.warn({ at: "Monitor#checkUnknownRelayers", message: "Unknown relayer 🛺", mrkdwn });
      }
    }
  }

  async reportUnfilledDeposits(): Promise<void> {
    const unfilledDeposits = await getUnfilledDeposits(
      this.clients.spokePoolClients,
      this.clients.hubPoolClient,
      this.monitorConfig.maxRelayerLookBack
    );

    // Group unfilled amounts by chain id and token id.
    const unfilledAmountByChainAndToken: { [chainId: number]: { [tokenAddress: string]: BigNumber } } = {};
    for (const deposit of unfilledDeposits) {
      const chainId = deposit.deposit.destinationChainId;
      const outputToken = sdkUtils.getDepositOutputToken(deposit.deposit);
      if (!unfilledAmountByChainAndToken[chainId] || !unfilledAmountByChainAndToken[chainId][outputToken]) {
        assign(unfilledAmountByChainAndToken, [chainId, outputToken], bnZero);
      }
      unfilledAmountByChainAndToken[chainId][outputToken] = unfilledAmountByChainAndToken[chainId][outputToken].add(
        deposit.unfilledAmount
      );
    }

    let mrkdwn = "";
    for (const [chainIdStr, amountByToken] of Object.entries(unfilledAmountByChainAndToken)) {
      // Skipping chains with no unfilled deposits.
      if (!amountByToken) {
        continue;
      }

      const chainId = parseInt(chainIdStr);
      mrkdwn += `*Destination: ${getNetworkName(chainId)}*\n`;
      for (const tokenAddress of Object.keys(amountByToken)) {
        const tokenInfo = this.clients.hubPoolClient.getL1TokenInfoForL2Token(tokenAddress, chainId);
        // Convert to number of tokens for readability.
        const unfilledAmount = convertFromWei(amountByToken[tokenAddress].toString(), tokenInfo.decimals);
        mrkdwn += `${tokenInfo.symbol}: ${unfilledAmount}\n`;
      }
    }

    if (mrkdwn) {
      this.logger.info({ at: "Monitor#reportUnfilledDeposits", message: "Unfilled deposits ⏱", mrkdwn });
    }
  }

  async reportRelayerBalances(): Promise<void> {
    const relayers = this.monitorConfig.monitoredRelayers;
    const allL1Tokens = this.clients.hubPoolClient.getL1Tokens();
    const chainIds = this.monitorChains;
    const allChainNames = chainIds.map(getNetworkName).concat([ALL_CHAINS_NAME, UNKNOWN_TRANSFERS_NAME]);
    const reports = this.initializeBalanceReports(relayers, allL1Tokens, allChainNames);

    await this.updateCurrentRelayerBalances(reports);
    await this.updateLatestAndFutureRelayerRefunds(reports);
    this.updateUnknownTransfers(reports);

    for (const relayer of relayers) {
      const report = reports[relayer];
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
  }

  // Update current balances of all tokens on each supported chain for each relayer.
  async updateCurrentRelayerBalances(relayerBalanceReport: RelayerBalanceReport): Promise<void> {
    const { hubPoolClient } = this.clients;
    const l1Tokens = hubPoolClient.getL1Tokens();
    for (const relayer of this.monitorConfig.monitoredRelayers) {
      for (const chainId of this.monitorChains) {
        const l2ToL1Tokens = Object.fromEntries(
          l1Tokens
            .filter(({ address: l1Token }) => hubPoolClient.l2TokenEnabledForL1Token(l1Token, chainId))
            .map((l1Token) => {
              const l2Token = hubPoolClient.getL2TokenForL1TokenAtBlock(l1Token.address, chainId);
              return [l2Token, l1Token];
            })
        );

        const l2TokenAddresses = Object.keys(l2ToL1Tokens);
        const tokenBalances = await this._getBalances(
          l2TokenAddresses.map((address) => ({
            token: address,
            chainId: chainId,
            account: relayer,
          }))
        );

        for (let i = 0; i < l2TokenAddresses.length; i++) {
          const tokenInfo = l2ToL1Tokens[l2TokenAddresses[i]];
          this.updateRelayerBalanceTable(
            relayerBalanceReport[relayer],
            tokenInfo.symbol,
            getNetworkName(chainId),
            BalanceType.CURRENT,
            tokenBalances[i]
          );
        }
      }
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
          warnThreshold: ethers.utils.parseUnits(warnThreshold.toString(), decimalValues[i]),
          errorThreshold: ethers.utils.parseUnits(errorThreshold.toString(), decimalValues[i]),
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

            if (warnThreshold !== null && balance.lt(ethers.utils.parseUnits(warnThreshold.toString(), decimals))) {
              trippedThreshold = { level: "warn", threshold: warnThreshold };
            }
            if (errorThreshold !== null && balance.lt(ethers.utils.parseUnits(errorThreshold.toString(), decimals))) {
              trippedThreshold = { level: "error", threshold: errorThreshold };
            }
            if (trippedThreshold !== null) {
              const ethAddressForChain = getEthAddressForChain(chainId);
              const symbol =
                token === ethAddressForChain
                  ? getNativeTokenSymbol(chainId)
                  : await new Contract(
                      token,
                      ERC20.abi,
                      this.clients.spokePoolClients[chainId].spokePool.provider
                    ).symbol();
              return {
                level: trippedThreshold.level,
                text: `  ${getNetworkName(chainId)} ${symbol} balance for ${blockExplorerLink(
                  account,
                  chainId
                )} is ${ethers.utils.formatUnits(balance, decimals)}. Threshold: ${trippedThreshold.threshold}`,
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
          token,
          account,
          currentBalance: currentBalances[i].toString(),
          target: ethers.utils.parseUnits(target.toString(), decimalValues[i]),
        };
      }),
    });

    // Compare current balances with triggers and send tokens if signer has enough balance.
    const signerAddress = await this.clients.hubPoolClient.hubPool.signer.getAddress();
    const promises = await Promise.allSettled(
      refillEnabledBalances.map(async ({ chainId, isHubPool, token, account, target, trigger }, i) => {
        const currentBalance = currentBalances[i];
        const decimals = decimalValues[i];
        const balanceTrigger = ethers.utils.parseUnits(trigger.toString(), decimals);
        const isBelowTrigger = currentBalance.lte(balanceTrigger);
        if (isBelowTrigger) {
          // Fill balance back to target, not trigger.
          const balanceTarget = ethers.utils.parseUnits(target.toString(), decimals);
          const deficit = balanceTarget.sub(currentBalance);
          const canRefill = await this.balanceAllocator.requestBalanceAllocation(
            chainId,
            [token],
            signerAddress,
            deficit
          );
          if (canRefill) {
            this.logger.debug({
              at: "Monitor#refillBalances",
              message: "Balance below trigger and can refill to target",
              from: signerAddress,
              to: account,
              balanceTrigger,
              balanceTarget,
              deficit,
              token,
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
                mrkdwn: `Loaded ${ethers.utils.formatUnits(deficit, decimals)} ETH from ${signerAddress}.`,
                value: deficit,
              });
            } else {
              // Note: We don't multicall sending ETH as its not a contract call.
              const gas = await getGasPrice(this.clients.spokePoolClients[chainId].spokePool.provider);
              const nativeSymbolForChain = getNativeTokenSymbol(chainId);
              const tx = await (
                await this.clients.spokePoolClients[chainId].spokePool.signer
              ).sendTransaction({ to: account, value: deficit, ...gas });
              const receipt = await tx.wait();
              this.logger.info({
                at: "Monitor#refillBalances",
                message: `Reloaded ${ethers.utils.formatUnits(
                  deficit,
                  decimals
                )} ${nativeSymbolForChain} for ${account} from ${signerAddress} 🫡!`,
                transactionHash: blockExplorerLink(receipt.transactionHash, chainId),
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

  // We approximate stuck rebalances by checking if there are still any pending cross chain transfers to any SpokePools
  // some fixed amount of time (grace period) after the last bundle execution. This can give false negative if there are
  // transfers stuck for longer than 1 bundle and the current time is within the last bundle execution + grace period.
  // But this should be okay as we should address any stuck transactions immediately so realistically no transfers
  // should stay unstuck for longer than one bundle.
  async checkStuckRebalances(): Promise<void> {
    const hubPoolClient = this.clients.hubPoolClient;
    const lastFullyExecutedBundle = hubPoolClient.getLatestFullyExecutedRootBundle(hubPoolClient.latestBlockSearched);
    // This case shouldn't happen outside of tests as Across V2 has already launched.
    if (lastFullyExecutedBundle === undefined) {
      return;
    }
    // If we're still within the grace period, skip looking for any stuck rebalances.
    // Again, this would give false negatives for transfers that have been stuck for longer than one bundle if the
    // current time is within the grace period of last executed bundle. But this is a good trade off for simpler code.
    const lastFullyExecutedBundleTime = lastFullyExecutedBundle.challengePeriodEndTimestamp;
    if (
      lastFullyExecutedBundleTime + REBALANCE_FINALIZE_GRACE_PERIOD >
      this.clients.hubPoolClient.hubPool.getCurrentTime()
    ) {
      return;
    }

    const allL1Tokens = this.clients.hubPoolClient.getL1Tokens();
    for (const chainId of this.crossChainAdapterSupportedChains) {
      // If chain wasn't active in latest bundle, then skip it.
      const chainIndex = this.clients.hubPoolClient.configStoreClient.getChainIdIndicesForBlock().indexOf(chainId);
      if (chainIndex >= lastFullyExecutedBundle.bundleEvaluationBlockNumbers.length) {
        continue;
      }
      const spokePoolAddress = this.clients.spokePoolClients[chainId].spokePool.address;
      for (const l1Token of allL1Tokens) {
        const transferBalance = this.clients.crossChainTransferClient.getOutstandingCrossChainTransferAmount(
          spokePoolAddress,
          chainId,
          l1Token.address
        );
        const outstandingDepositTxs = blockExplorerLinks(
          this.clients.crossChainTransferClient.getOutstandingCrossChainTransferTxs(
            spokePoolAddress,
            chainId,
            l1Token.address
          ),
          1
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
    const validatedBundleRefunds: FillsToRefund[] =
      await this.clients.bundleDataClient.getPendingRefundsFromValidBundles(this.monitorConfig.bundleRefundLookback);
    const nextBundleRefunds = await this.clients.bundleDataClient.getNextBundleRefunds();

    // Calculate which fills have not yet been refunded for each monitored relayer.
    for (const refunds of validatedBundleRefunds) {
      for (const relayer of this.monitorConfig.monitoredRelayers) {
        this.updateRelayerRefunds(refunds, relayerBalanceReport[relayer], relayer, BalanceType.PENDING);
      }
    }
    for (const relayer of this.monitorConfig.monitoredRelayers) {
      this.updateRelayerRefunds(nextBundleRefunds, relayerBalanceReport[relayer], relayer, BalanceType.NEXT);
      this.updateCrossChainTransfers(relayer, relayerBalanceReport[relayer]);
    }
  }

  updateCrossChainTransfers(relayer: string, relayerBalanceTable: RelayerBalanceTable): void {
    const allL1Tokens = this.clients.hubPoolClient.getL1Tokens();
    for (const chainId of this.crossChainAdapterSupportedChains) {
      for (const l1Token of allL1Tokens) {
        const transferBalance = this.clients.crossChainTransferClient.getOutstandingCrossChainTransferAmount(
          relayer,
          chainId,
          l1Token.address
        );

        if (transferBalance.gt(bnZero)) {
          this.updateRelayerBalanceTable(
            relayerBalanceTable,
            l1Token.symbol,
            getNetworkName(chainId),
            BalanceType.PENDING_TRANSFERS,
            transferBalance
          );
        }
      }
    }
  }

  updateUnknownTransfers(relayerBalanceReport: RelayerBalanceReport): void {
    const { hubPoolClient, spokePoolClients } = this.clients;

    for (const relayer of this.monitorConfig.monitoredRelayers) {
      const report = relayerBalanceReport[relayer];
      const transfersPerChain: TransfersByChain = this.clients.tokenTransferClient.getTokenTransfers(relayer);

      let mrkdwn = "";
      for (const chainId of this.monitorChains) {
        const spokePoolClient = spokePoolClients[chainId];
        const transfersPerToken: TransfersByTokens = transfersPerChain[chainId];
        const l2ToL1Tokens = Object.fromEntries(
          Object.keys(transfersPerToken).map((l2Token) => [
            l2Token,
            hubPoolClient.getL1TokenForL2TokenAtBlock(l2Token, chainId, hubPoolClient.latestBlockSearched),
          ])
        );

        let currentChainMrkdwn = "";
        for (const l2Token of Object.keys(l2ToL1Tokens)) {
          let currentTokenMrkdwn = "";

          const tokenInfo = hubPoolClient.getL1TokenInfoForL2Token(l2Token, chainId);
          const transfers = transfersPerToken[l2Token];
          // Skip if there has been no transfers of this token.
          if (!transfers) {
            continue;
          }

          let totalOutgoingAmount = bnZero;
          // Filter v2 fills and bond payments from outgoing transfers.
          const fillTransactionHashes = spokePoolClient.getFillsForRelayer(relayer).map((fill) => fill.transactionHash);
          const outgoingTransfers = this.categorizeUnknownTransfers(transfers.outgoing, fillTransactionHashes);
          if (outgoingTransfers.all.length > 0) {
            currentTokenMrkdwn += "Outgoing:\n";
            totalOutgoingAmount = totalOutgoingAmount.add(this.getTotalTransferAmount(outgoingTransfers.all));
            currentTokenMrkdwn += this.formatCategorizedTransfers(outgoingTransfers, tokenInfo.decimals, chainId);
          }

          let totalIncomingAmount = bnZero;
          // Filter v2 refunds and bond repayments from incoming transfers.
          const refundTransactionHashes = spokePoolClient
            .getRelayerRefundExecutions()
            .map((refund) => refund.transactionHash);
          const incomingTransfers = this.categorizeUnknownTransfers(transfers.incoming, refundTransactionHashes);
          if (incomingTransfers.all.length > 0) {
            currentTokenMrkdwn += "Incoming:\n";
            totalIncomingAmount = totalIncomingAmount.add(this.getTotalTransferAmount(incomingTransfers.all));
            currentTokenMrkdwn += this.formatCategorizedTransfers(incomingTransfers, tokenInfo.decimals, chainId);
          }

          // Record if there are net outgoing transfers.
          const netTransfersAmount = totalIncomingAmount.sub(totalOutgoingAmount);
          if (!netTransfersAmount.eq(bnZero)) {
            const netAmount = convertFromWei(netTransfersAmount.toString(), tokenInfo.decimals);
            currentTokenMrkdwn = `*${tokenInfo.symbol}: Net ${netAmount}*\n` + currentTokenMrkdwn;
            currentChainMrkdwn += currentTokenMrkdwn;

            // Report (incoming, outgoing, net) amounts.
            this.incrementBalance(
              report,
              tokenInfo.symbol,
              UNKNOWN_TRANSFERS_NAME,
              BalanceType.CURRENT,
              totalIncomingAmount
            );
            this.incrementBalance(
              report,
              tokenInfo.symbol,
              UNKNOWN_TRANSFERS_NAME,
              BalanceType.PENDING,
              totalOutgoingAmount.mul(-1)
            );
            this.incrementBalance(
              report,
              tokenInfo.symbol,
              UNKNOWN_TRANSFERS_NAME,
              BalanceType.NEXT,
              netTransfersAmount
            );
          }
        }

        // We only add to the markdown message if there was any unknown transfer for any token on this current chain.
        if (currentChainMrkdwn) {
          currentChainMrkdwn = `*[${getNetworkName(chainId)}]*\n` + currentChainMrkdwn;
          mrkdwn += currentChainMrkdwn + "\n\n";
        }
      }

      if (mrkdwn) {
        this.logger.info({
          at: "Monitor#updateUnknownTransfers",
          message: `Transfers that are not fills for relayer ${relayer} 🦨`,
          mrkdwn,
        });
      }
    }
  }

  categorizeUnknownTransfers(transfers: TokenTransfer[], excludeTransactionHashes: string[]): CategorizedTransfers {
    // Exclude specified transaction hashes.
    const allUnknownOutgoingTransfers = transfers.filter((transfer) => {
      return !excludeTransactionHashes.includes(transfer.transactionHash);
    });

    const hubPoolAddress = this.clients.hubPoolClient.hubPool.address;
    const v1 = [];
    const other = [];
    const bond = [];
    const v1Addresses = this.monitorConfig.knownV1Addresses;
    for (const transfer of allUnknownOutgoingTransfers) {
      if (transfer.from === hubPoolAddress || transfer.to === hubPoolAddress) {
        bond.push(transfer);
      } else if (v1Addresses.includes(transfer.from) || v1Addresses.includes(transfer.to)) {
        v1.push(transfer);
      } else {
        other.push(transfer);
      }
    }
    return { bond, v1, other, all: allUnknownOutgoingTransfers };
  }

  formatCategorizedTransfers(transfers: CategorizedTransfers, decimals: number, chainId: number): string {
    let mrkdwn = this.formatKnownTransfers(transfers.bond, decimals, "bond");
    mrkdwn += this.formatKnownTransfers(transfers.v1, decimals, "v1");
    mrkdwn += this.formatOtherTransfers(transfers.other, decimals, chainId);
    return mrkdwn + "\n";
  }

  formatKnownTransfers(transfers: TokenTransfer[], decimals: number, transferType: string): string {
    if (transfers.length === 0) {
      return "";
    }

    const totalAmount = this.getTotalTransferAmount(transfers);
    return `${transferType}: ${convertFromWei(totalAmount.toString(), decimals)}\n`;
  }

  formatOtherTransfers(transfers: TokenTransfer[], decimals: number, chainId: number): string {
    if (transfers.length === 0) {
      return "";
    }

    const totalAmount = this.getTotalTransferAmount(transfers);
    let mrkdwn = `other: ${convertFromWei(totalAmount.toString(), decimals)}\n`;
    const transactionHashes = [...new Set(transfers.map((transfer) => transfer.transactionHash))];
    mrkdwn += blockExplorerLinks(transactionHashes, chainId);
    return mrkdwn;
  }

  getTotalTransferAmount(transfers: TokenTransfer[]): BigNumber {
    return transfers.map((transfer) => transfer.value).reduce((a, b) => a.add(b));
  }

  initializeBalanceReports(relayers: string[], allL1Tokens: L1Token[], allChainNames: string[]): RelayerBalanceReport {
    const reports: RelayerBalanceReport = {};
    for (const relayer of relayers) {
      reports[relayer] = {};
      for (const token of allL1Tokens) {
        reports[relayer][token.symbol] = {};
        for (const chainName of allChainNames) {
          reports[relayer][token.symbol][chainName] = {};
          for (const balanceType of ALL_BALANCE_TYPES) {
            reports[relayer][token.symbol][chainName][balanceType] = bnZero;
          }
        }
      }
    }
    return reports;
  }

  private updateRelayerRefunds(
    fillsToRefundPerChain: FillsToRefund,
    relayerBalanceTable: RelayerBalanceTable,
    relayer: string,
    balanceType: BalanceType
  ) {
    for (const chainId of this.monitorChains) {
      const fillsToRefund = fillsToRefundPerChain[chainId];
      // Skip chains that don't have any refunds.
      if (fillsToRefund === undefined) {
        continue;
      }

      for (const tokenAddress of Object.keys(fillsToRefund)) {
        // Skip token if there are no refunds (although there are valid fills).
        // This is an edge case that shouldn't usually happen.
        if (fillsToRefund[tokenAddress].refunds === undefined) {
          continue;
        }

        const totalRefundAmount = fillsToRefund[tokenAddress].refunds[relayer];
        const tokenInfo = this.clients.hubPoolClient.getL1TokenInfoForL2Token(tokenAddress, chainId);
        const amount = totalRefundAmount ?? bnZero;
        this.updateRelayerBalanceTable(
          relayerBalanceTable,
          tokenInfo.symbol,
          getNetworkName(chainId),
          balanceType,
          amount
        );
      }
    }
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

  private notifyIfUnknownCaller(caller: string, action: BundleAction, transactionHash: string) {
    if (this.monitorConfig.whitelistedDataworkers.includes(caller)) {
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
      `\ntx: ${blockExplorerLink(transactionHash, 1)}`;
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
      const { startingBlock, endingBlock } = await this.computeStartingAndEndingBlock(
        this.clients.spokePoolClients[chainId].spokePool.provider,
        this.monitorConfig.spokePoolsBlocks[chainId]?.startingBlock,
        this.monitorConfig.spokePoolsBlocks[chainId]?.endingBlock
      );

      this.spokePoolsBlocks[chainId].startingBlock = startingBlock;
      this.spokePoolsBlocks[chainId].endingBlock = endingBlock;
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
        if (this.balanceCache[chainId]?.[token]?.[account]) {
          return this.balanceCache[chainId][token][account];
        }
        const ethAddressForChain = getEthAddressForChain(chainId);
        const balance =
          token === ethAddressForChain
            ? await this.clients.spokePoolClients[chainId].spokePool.provider.getBalance(account)
            : // Use the latest block number the SpokePoolClient is aware of to query balances.
              // This prevents double counting when there are very recent refund leaf executions that the SpokePoolClients
              // missed (the provider node did not see those events yet) but when the balanceOf calls are made, the node
              // is now aware of those executions.
              await new Contract(token, ERC20.abi, this.clients.spokePoolClients[chainId].spokePool.provider).balanceOf(
                account,
                { blockTag: this.clients.spokePoolClients[chainId].latestBlockSearched }
              );
        if (!this.balanceCache[chainId]) {
          this.balanceCache[chainId] = {};
        }
        if (!this.balanceCache[chainId][token]) {
          this.balanceCache[chainId][token] = {};
        }
        this.balanceCache[chainId][token][account] = balance;
        return balance;
      })
    );
  }

  private async _getDecimals(decimalrequests: { chainId: number; token: string }[]): Promise<number[]> {
    return await Promise.all(
      decimalrequests.map(async ({ chainId, token }) => {
        const ethAddressForChain = getEthAddressForChain(chainId);
        if (token === ethAddressForChain) {
          return 18;
        } // Assume all EVM chains have 18 decimal native tokens.
        if (this.decimals[chainId]?.[token]) {
          return this.decimals[chainId][token];
        }
        const decimals: number = await new Contract(
          token,
          ERC20.abi,
          this.clients.spokePoolClients[chainId].spokePool.provider
        ).decimals();
        if (!this.decimals[chainId]) {
          this.decimals[chainId] = {};
        }
        if (!this.decimals[chainId][token]) {
          this.decimals[chainId][token] = decimals;
        }
        return decimals;
      })
    );
  }
}

import { FillsToRefund } from "../interfaces";
import { BundleAction, BalanceType, L1Token, RelayerBalanceTable, RelayerBalanceReport } from "../interfaces";
import { BigNumber, Contract, ERC20, assign, etherscanLink } from "../utils";
import {
  convertFromWei,
  toBN,
  toWei,
  winston,
  createFormatFunction,
  getNetworkName,
  getUnfilledDeposits,
  providers,
} from "../utils";

import { MonitorClients, updateMonitorClients } from "./MonitorClientHelper";
import { MonitorConfig } from "./MonitorConfig";

const ALL_CHAINS_NAME = "All chains";
const ALL_BALANCE_TYPES = [BalanceType.CURRENT, BalanceType.PENDING, BalanceType.NEXT, BalanceType.TOTAL];

export class Monitor {
  // Block range to search is only defined on calling update().
  private hubPoolStartingBlock: number | undefined = undefined;
  private hubPoolEndingBlock: number | undefined = undefined;
  private spokePoolsBlocks: Record<number, { startingBlock: number | undefined; endingBlock: number | undefined }> = {};

  public constructor(
    readonly logger: winston.Logger,
    readonly monitorConfig: MonitorConfig,
    readonly clients: MonitorClients
  ) {
    for (const chainId of monitorConfig.spokePoolChains) {
      this.spokePoolsBlocks[chainId] = { startingBlock: undefined, endingBlock: undefined };
    }
  }

  public async update() {
    await updateMonitorClients(this.clients);
    await this.computeHubPoolBlocks();
    await this.computeSpokePoolsBlocks();
  }

  async checkUtilization() {
    this.logger.debug({ at: "AcrossMonitor#Utilization", message: "Checking for pool utilization ratio" });
    const l1Tokens = this.clients.hubPoolClient.getL1Tokens();
    const l1TokenUtilizations = await Promise.all(
      l1Tokens.map(async (l1Token) => {
        const utilization = await this.clients.hubPoolClient.getCurrentPoolUtilization(l1Token.address);
        return {
          l1Token: l1Token.address,
          chainId: this.monitorConfig.hubPoolChainId,
          poolCollateralSymbol: this.clients.hubPoolClient.getTokenInfoForL1Token(l1Token.address).symbol,
          utilization: toBN(utilization),
        };
      })
    );
    // Send notification if pool utilization is above configured threshold.
    for (const l1TokenUtilization of l1TokenUtilizations) {
      if (l1TokenUtilization.utilization.gt(toBN(this.monitorConfig.utilizationThreshold).mul(toBN(toWei("0.01"))))) {
        const utilizationString = l1TokenUtilization.utilization.mul(100).toString();
        const mrkdwn = `${l1TokenUtilization.poolCollateralSymbol} pool token at \
          ${etherscanLink(l1TokenUtilization.l1Token, l1TokenUtilization.chainId)} on \
          ${getNetworkName(l1TokenUtilization.chainId)} is at \
          ${createFormatFunction(0, 2)(utilizationString)}% utilization!"`;
        this.logger.warn({ at: "UtilizationMonitor", message: "High pool utilization warning 🏊", mrkdwn });
      }
    }
  }

  async checkUnknownRootBundleCallers(): Promise<void> {
    this.logger.debug({ at: "AcrossMonitor#RootBundleCallers", message: "Checking for unknown root bundle callers" });

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

  async checkUnknownRelayers() {
    const chainIds = this.monitorConfig.spokePoolChains;
    this.logger.debug({ at: "AcrossMonitor#UnknownRelayers", message: "Checking for unknown relayers", chainIds });
    for (const chainId of chainIds) {
      const fills = this.clients.spokePoolClients[chainId].getFillsWithBlockInRange(
        this.spokePoolsBlocks[chainId].startingBlock,
        this.spokePoolsBlocks[chainId].endingBlock
      );
      for (const fill of fills) {
        // Skip notifications for known relay caller addresses.
        if (this.monitorConfig.whitelistedRelayers.includes(fill.relayer)) continue;

        const mrkdwn =
          `An unknown relayer ${etherscanLink(fill.relayer, chainId)}` +
          ` filled a deposit on ${getNetworkName(chainId)}\ntx: ${etherscanLink(fill.transactionHash, chainId)}`;
        this.logger.error({ at: "Monitor", message: "Unknown relayer 🛺", mrkdwn });
      }
    }
  }

  async reportUnfilledDeposits() {
    const unfilledDeposits = getUnfilledDeposits(this.clients.spokePoolClients);

    // Group unfilled amounts by chain id and token id.
    const unfilledAmountByChainAndToken: { [chainId: number]: { [tokenAddress: string]: BigNumber } } = {};
    for (const deposit of unfilledDeposits) {
      const chainId = deposit.deposit.originChainId;
      const tokenAddress = deposit.deposit.originToken;
      if (!unfilledAmountByChainAndToken[chainId] || !unfilledAmountByChainAndToken[chainId][tokenAddress]) {
        assign(unfilledAmountByChainAndToken, [chainId, tokenAddress], BigNumber.from(0));
      }
      unfilledAmountByChainAndToken[chainId][tokenAddress] = unfilledAmountByChainAndToken[chainId][tokenAddress].add(
        deposit.unfilledAmount
      );
    }

    let mrkdwn = "";
    for (const [chainIdStr, amountByToken] of Object.entries(unfilledAmountByChainAndToken)) {
      // Skipping chains with no unfilled deposits.
      if (!amountByToken) continue;

      const chainId = parseInt(chainIdStr);
      mrkdwn += `*Chain ${chainId}*\n`;
      for (const tokenAddress of Object.keys(amountByToken)) {
        const tokenInfo = this.clients.hubPoolClient.getL1TokenInfoForL2Token(tokenAddress, chainId);
        // Convert to number of tokens for readability.
        const unfilledAmount = convertFromWei(amountByToken[tokenAddress].toString(), tokenInfo.decimals);
        mrkdwn += `${tokenInfo.symbol}: ${unfilledAmount}\n`;
      }
    }

    if (mrkdwn) {
      this.logger.info({ at: "Monitor", message: "Unfilled deposits ⏱", mrkdwn });
    }
  }

  async reportRelayerBalances() {
    const relayers = this.monitorConfig.monitoredRelayers;
    const allL1Tokens = this.clients.hubPoolClient.getL1Tokens();
    const chainIds = this.monitorConfig.spokePoolChains;
    const allChainNames = chainIds.map(getNetworkName).concat([ALL_CHAINS_NAME]);
    const reports = this.initializeBalanceReports(relayers, allL1Tokens, allChainNames);

    await this.updateCurrentRelayerBalances(reports);
    this.updatePendingAndFutureRelayerRefunds(reports);

    for (const relayer of relayers) {
      const report = reports[relayer];
      let mrkdwn = "Token amounts: current, in liveness, next bundle, total\n";
      for (const token of allL1Tokens) {
        mrkdwn += `*[${token.symbol}]*\n`;
        for (const chainName of allChainNames) {
          const balances = Object.values(report[token.symbol][chainName]).map((balance) =>
            convertFromWei(balance.toString(), token.decimals)
          );
          mrkdwn += `${chainName}: ${balances.join(", ")}\n`;
        }
      }
      this.logger.info({
        at: "Monitor",
        message: `Balance report for ${relayer} 📖`,
        mrkdwn,
      });
    }
  }

  // Update current balances of all tokens on each supported chain for each relayer.
  async updateCurrentRelayerBalances(relayerBalanceReport: RelayerBalanceReport) {
    for (const relayer of this.monitorConfig.monitoredRelayers) {
      for (const chainId of this.monitorConfig.spokePoolChains) {
        const l2ToL1Tokens = this.clients.hubPoolClient.getDestinationTokensToL1TokensForChainId(chainId);

        // Use the provider from the spoke pool to send requests to the right provider.
        const spokePoolClient = this.clients.spokePoolClients[chainId];
        const l2TokenAddresses = Object.keys(l2ToL1Tokens);
        const tokenBalances = await Promise.all(
          l2TokenAddresses.map((l2TokenAddress) =>
            new Contract(l2TokenAddress, ERC20.abi, spokePoolClient.spokePool.signer).balanceOf(relayer)
          )
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

  updatePendingAndFutureRelayerRefunds(relayerBalanceReport: RelayerBalanceReport) {
    const hubPoolClient = this.clients.hubPoolClient;
    const latestBlockNumber = hubPoolClient.latestBlockNumber;
    const latestBundle = hubPoolClient.getMostRecentProposedRootBundle(latestBlockNumber);
    const chainIds = this.monitorConfig.spokePoolChains;

    // Refunds that will be processed in the current bundle still pending liveness (if any).
    let pendingFillsToRefundPerChain: FillsToRefund | undefined = undefined;

    // If latest proposed bundle has not been executed yet, we have a bundle pending liveness.
    if (hubPoolClient.getExecutedLeavesForRootBundle(latestBundle, latestBlockNumber).length == 0) {
      // Use the same block range as the current pending bundle to ensure we look at the right refunds.
      const pendingBundleEvaluationBlockRanges: number[][] = latestBundle.bundleEvaluationBlockNumbers.map(
        (endBlock, i) => [
          hubPoolClient.getNextBundleStartBlockNumber(chainIds, latestBlockNumber, chainIds[i]),
          endBlock.toNumber(),
        ]
      );
      const { fillsToRefund } = this.clients.bundleDataClient.loadData(
        pendingBundleEvaluationBlockRanges,
        this.clients.spokePoolClients,
        false
      );
      pendingFillsToRefundPerChain = fillsToRefund;
    }

    // The future bundle covers block range from the ending of the last proposed bundle (might still be pending liveness)
    // to the latest block.
    const futureBundleEvaluationBlockRanges: number[][] = latestBundle.bundleEvaluationBlockNumbers.map(
      (endingBlock) => [endingBlock.toNumber() + 1, latestBlockNumber]
    );
    // Refunds that will be processed in the next bundle that will be proposed after the current pending bundle
    // (if any) has been fully executed.
    const { fillsToRefund: futureFillsToRefundPerChain } = this.clients.bundleDataClient.loadData(
      futureBundleEvaluationBlockRanges,
      this.clients.spokePoolClients,
      false
    );

    // Calculate which fills have not yet been refunded for each monitored relayer.
    for (const relayer of this.monitorConfig.monitoredRelayers) {
      this.updateRelayerRefunds(
        pendingFillsToRefundPerChain,
        relayerBalanceReport[relayer],
        relayer,
        BalanceType.PENDING
      );

      this.updateRelayerRefunds(futureFillsToRefundPerChain, relayerBalanceReport[relayer], relayer, BalanceType.NEXT);
    }
  }

  initializeBalanceReports(relayers: string[], allL1Tokens: L1Token[], allChainNames: string[]) {
    const reports: RelayerBalanceReport = {};
    for (const relayer of relayers) {
      reports[relayer] = {};
      for (const token of allL1Tokens) {
        reports[relayer][token.symbol] = {};
        for (const chainName of allChainNames) {
          reports[relayer][token.symbol][chainName] = {};
          for (const balanceType of ALL_BALANCE_TYPES) {
            reports[relayer][token.symbol][chainName][balanceType] = BigNumber.from(0);
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
    // Short-circuit if there are no refunds to process.
    if (!fillsToRefundPerChain) return;

    for (const chainId of this.monitorConfig.spokePoolChains) {
      const fillsToRefund = fillsToRefundPerChain[chainId];
      // Skip chains that don't have any refunds.
      if (!fillsToRefund) continue;

      for (const tokenAddress of Object.keys(fillsToRefund)) {
        const totalRefundAmount = fillsToRefund[tokenAddress].refunds[relayer];
        const tokenInfo = this.clients.hubPoolClient.getL1TokenInfoForL2Token(tokenAddress, chainId);
        let amount = totalRefundAmount ? totalRefundAmount : BigNumber.from(0);
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
      `An unknown EOA ${etherscanLink(caller, 1)} has ${action} a bundle on ${getNetworkName(1)}` +
      `\ntx: ${etherscanLink(transactionHash, 1)}`;
    this.logger.error({ at: "Monitor", message: `Unknown bundle caller (${action}) ${emoji}`, mrkdwn });
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
    for (const chainId of this.monitorConfig.spokePoolChains) {
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
}

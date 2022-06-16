import {
  FillsToRefund,
  ProposedRootBundle,
  TokenTransfer,
  BundleAction,
  BalanceType,
  L1Token,
  RelayerBalanceTable,
  RelayerBalanceReport,
  TransfersByChain,
  TransfersByTokens,
} from "../interfaces";
import { BigNumber, Contract, ERC20, assign, etherscanLink, etherscanLinks, getTransactionHashes ,
  convertFromWei,
  toBN,
  toWei,
  winston,
  createFormatFunction,
  getNetworkName,
  getUnfilledDeposits,
  providers,
, ethers } from "../utils";

import { MonitorClients, updateMonitorClients } from "./MonitorClientHelper";
import { MonitorConfig } from "./MonitorConfig";

export const ALL_CHAINS_NAME = "All chains";
export const UNKNOWN_TRANSFERS_NAME = "Unknown transfers (incoming, outgoing, net)";
const ALL_BALANCE_TYPES = [BalanceType.CURRENT, BalanceType.PENDING, BalanceType.NEXT, BalanceType.TOTAL];

interface CategorizedTransfers {
  all: TokenTransfer[];
  bond: TokenTransfer[];
  v1: TokenTransfer[];
  other: TokenTransfer[];
}

export class Monitor {
  // Block range to search is only defined on calling update().
  private hubPoolStartingBlock: number | undefined = undefined;
  private hubPoolEndingBlock: number | undefined = undefined;
  private spokePoolsBlocks: Record<number, { startingBlock: number | undefined; endingBlock: number | undefined }> = {};
  private balanceCache: { [chainId: number]: { [token: string]: { [account: string]: BigNumber } } } = {};
  private decimals: { [chainId: number]: { [token: string]: number } } = {};

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
    const tokensPerChain = Object.fromEntries(
      this.monitorConfig.spokePoolChains.map((chainId) => {
        const l2Tokens = this.clients.hubPoolClient.getDestinationTokensToL1TokensForChainId(chainId);
        return [chainId, Object.keys(l2Tokens)];
      })
    );
    await this.clients.tokenTransferClient.update(searchConfigs, tokensPerChain);
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
      const chainId = deposit.deposit.destinationChainId;
      const tokenAddress = deposit.deposit.destinationToken;
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
      mrkdwn += `*Destination: ${getNetworkName(chainId)}*\n`;
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
    const allChainNames = chainIds.map(getNetworkName).concat([ALL_CHAINS_NAME, UNKNOWN_TRANSFERS_NAME]);
    const reports = this.initializeBalanceReports(relayers, allL1Tokens, allChainNames);

    await this.updateCurrentRelayerBalances(reports);
    this.updatePendingAndFutureRelayerRefunds(reports);
    this.updateUnknownTransfers(reports);

    for (const relayer of relayers) {
      const report = reports[relayer];
      let summaryMrkdwn = "*[Summary]*\n";
      let mrkdwn = "Token amounts: current, in liveness, next bundle, total\n";
      for (const token of allL1Tokens) {
        let tokenMrkdwn = "";
        for (const chainName of allChainNames) {
          const balancesBN = Object.values(report[token.symbol][chainName]);
          if (balancesBN.find((b) => b.gt(BigNumber.from(0)))) {
            // Human-readable balances
            const balances = balancesBN.map((balance) =>
              balance.gt(BigNumber.from(0)) ? convertFromWei(balance.toString(), token.decimals) : "0"
            );
            tokenMrkdwn += `${chainName}: ${balances.join(", ")}\n`;
          } else {
            // Shorten balances in the report if everything is 0.
            tokenMrkdwn += `${chainName}: 0\n`;
          }
        }

        const totalBalance = report[token.symbol][ALL_CHAINS_NAME][BalanceType.TOTAL];
        // Update corresponding summary section for current token.
        if (totalBalance.gt(BigNumber.from(0))) {
          mrkdwn += `*[${token.symbol}]*\n` + tokenMrkdwn;
          summaryMrkdwn += `${token.symbol}: ${convertFromWei(totalBalance.toString(), token.decimals)}\n`;
        } else {
          summaryMrkdwn += `${token.symbol}: 0\n`;
        }
      }

      mrkdwn += summaryMrkdwn;
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

  async checkBalances() {
    const { monitoredBalances } = this.monitorConfig;
    const balances = await this._getBalances(monitoredBalances);
    const decimalValues = await this._getDecimals(monitoredBalances);
    const alertText = (await Promise.all(
      this.monitorConfig.monitoredBalances.map(async ({ chainId, token, account, threshold }, i) => {
        const balance = balances[i];
        const decimals = decimalValues[i];
        if (balance.lt(ethers.utils.parseUnits(threshold.toString(), decimals))) {
          const symbol = await new Contract(token, ERC20.abi, this.clients.spokePoolClients[chainId].spokePool.provider).symbol();
          return `  ${getNetworkName(chainId)} ${symbol} balance for ${etherscanLink(account, chainId)} is ${ethers.utils.formatUnits(balance, decimals)}. Threshold: ${threshold}`;
        }
      })
    )).filter(text => text !== undefined);
    if (alertText.length > 0) {
      const mrkdwn = "Some balance(s) are below the configured threshold!\n" + alertText.join("\n");
      this.logger.error({ at: "Monitor", message: "Balance(s) below threshold", mrkdwn: mrkdwn });
    }
  }

  updatePendingAndFutureRelayerRefunds(relayerBalanceReport: RelayerBalanceReport) {
    const pendingBundleRefunds = this.clients.bundleDataClient.getPendingBundleRefunds();
    const nextBundleRefunds = this.clients.bundleDataClient.getNextBundleRefunds();

    // Calculate which fills have not yet been refunded for each monitored relayer.
    for (const relayer of this.monitorConfig.monitoredRelayers) {
      this.updateRelayerRefunds(pendingBundleRefunds, relayerBalanceReport[relayer], relayer, BalanceType.PENDING);
      this.updateRelayerRefunds(nextBundleRefunds, relayerBalanceReport[relayer], relayer, BalanceType.NEXT);
    }
  }

  updateUnknownTransfers(relayerBalanceReport: RelayerBalanceReport) {
    const hubPoolClient = this.clients.hubPoolClient;

    for (const relayer of this.monitorConfig.monitoredRelayers) {
      const report = relayerBalanceReport[relayer];
      const transfersPerChain: TransfersByChain = this.clients.tokenTransferClient.getTokenTransfers(relayer);

      let mrkdwn = "";
      for (const chainId of this.monitorConfig.spokePoolChains) {
        const spokePoolClient = this.clients.spokePoolClients[chainId];
        const transfersPerToken: TransfersByTokens = transfersPerChain[chainId];
        const l2ToL1Tokens = hubPoolClient.getDestinationTokensToL1TokensForChainId(chainId);

        let currentChainMrkdwn = "";
        for (const l2Token of Object.keys(l2ToL1Tokens)) {
          let currentTokenMrkdwn = "";

          const tokenInfo = hubPoolClient.getL1TokenInfoForL2Token(l2Token, chainId);
          const transfers = transfersPerToken[l2Token];
          // Skip if there has been no transfers of this token.
          if (!transfers) continue;

          let totalOutgoingAmount = BigNumber.from(0);
          // Filter v2 fills and bond payments from outgoing transfers.
          const fillTransactionHashes = spokePoolClient
            .getFillsWithBlockForDestinationChainAndRelayer(chainId, relayer)
            .map((fill) => fill.transactionHash);
          const outgoingTransfers = this.categorizeUnknownTransfers(transfers.outgoing, fillTransactionHashes);
          if (outgoingTransfers.all.length > 0) {
            currentTokenMrkdwn += "Outgoing:\n";
            totalOutgoingAmount = totalOutgoingAmount.add(this.getTotalTransferAmount(outgoingTransfers.all));
            currentTokenMrkdwn += this.formatCategorizedTransfers(outgoingTransfers, tokenInfo.decimals, chainId);
          }

          let totalIncomingAmount = BigNumber.from(0);
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
          if (!netTransfersAmount.eq(BigNumber.from(0))) {
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
              totalOutgoingAmount.mul(BigNumber.from(-1))
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
          at: "Monitor",
          message: `There are non-v2 transfers for relayer ${relayer} 🦨`,
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

  formatCategorizedTransfers(transfers: CategorizedTransfers, decimals: number, chainId: number) {
    let mrkdwn = this.formatKnownTransfers(transfers.bond, decimals, "bond");
    mrkdwn += this.formatKnownTransfers(transfers.v1, decimals, "v1");
    mrkdwn += this.formatOtherTransfers(transfers.other, decimals, chainId);
    return mrkdwn + "\n";
  }

  formatKnownTransfers(transfers: TokenTransfer[], decimals: number, transferType: String) {
    if (transfers.length === 0) return "";

    const totalAmount = this.getTotalTransferAmount(transfers);
    return `${transferType}: ${convertFromWei(totalAmount.toString(), decimals)}\n`;
  }

  formatOtherTransfers(transfers: TokenTransfer[], decimals: number, chainId: number) {
    if (transfers.length === 0) return "";

    const totalAmount = this.getTotalTransferAmount(transfers);
    let mrkdwn = `other: ${convertFromWei(totalAmount.toString(), decimals)}\n`;
    mrkdwn += etherscanLinks(
      transfers.map((transfer) => transfer.transactionHash),
      chainId
    );
    return mrkdwn;
  }

  getTotalTransferAmount(transfers: TokenTransfer[]) {
    return transfers.map((transfer) => transfer.value).reduce((a, b) => a.add(b));
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
    for (const chainId of this.monitorConfig.spokePoolChains) {
      const fillsToRefund = fillsToRefundPerChain[chainId];
      // Skip chains that don't have any refunds.
      if (!fillsToRefund) continue;

      for (const tokenAddress of Object.keys(fillsToRefund)) {
        const totalRefundAmount = fillsToRefund[tokenAddress].refunds[relayer];
        const tokenInfo = this.clients.hubPoolClient.getL1TokenInfoForL2Token(tokenAddress, chainId);
        const amount = totalRefundAmount || BigNumber.from(0);
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

  private async _getBalances(
    balanceRequests: { chainId: number; token?: string; account: string }[]
  ): Promise<BigNumber[]> {
    return await Promise.all(
      balanceRequests.map(async ({ chainId, token, account }) => {
        if (!token) token = "native";
        if (this.balanceCache[chainId]?.[token]?.[account]) return this.balanceCache[chainId][token][account];
        const balance =
          token === "native"
            ? await this.clients.spokePoolClients[chainId].spokePool.provider.getBalance(account)
            : await new Contract(token, ERC20.abi, this.clients.spokePoolClients[chainId].spokePool.provider).balanceOf(
                account
              );
        if (!this.balanceCache[chainId]) this.balanceCache[chainId] = {};
        if (!this.balanceCache[chainId][token]) this.balanceCache[chainId][token] = {};
        this.balanceCache[chainId][token][account] = balance;
        return balance;
      })
    );
  }

  private async _getDecimals(decimalrequests: { chainId: number; token?: string }[]): Promise<number[]> {
    return await Promise.all(
      decimalrequests.map(async ({ chainId, token }) => {
        if (!token) return 18; // Assume all EVM chains have 18 decimal native tokens.
        if (this.decimals[chainId]?.[token]) return this.decimals[chainId][token];
        const decimals = await new Contract(
          token,
          ERC20.abi,
          this.clients.spokePoolClients[chainId].spokePool.provider
        ).decimals();
        if (!this.decimals[chainId]) this.decimals[chainId] = {};
        if (!this.decimals[chainId][token]) this.decimals[chainId][token] = decimals.toNumber();
        return decimals.toNumber();
      })
    );
  }
}

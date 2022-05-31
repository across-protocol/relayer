import { getCurrentTime } from "../utils/TimeUtils";
import { Contract, ERC20, assign, etherscanLink } from "../utils";
import { convertFromWei, toBN, toWei, winston, createFormatFunction, getNetworkName, providers } from "../utils";

import { MonitorClients, updateMonitorClients } from "./MonitorClientHelper";
import { MonitorConfig } from "./MonitorConfig";

import { L1Token } from "../interfaces";

enum BundleAction {
  PROPOSED = "proposed",
  DISPUTED = "disputed",
  CANCELED = "canceled",
}

export class Monitor {
  // Block range to search is only defined on calling update().
  private hubPoolStartingBlock: number | undefined = undefined;
  private hubPoolEndingBlock: number | undefined = undefined;
  private spokePoolsBlocks: Record<number, { startingBlock: number | undefined; endingBlock: number | undefined }> = {};
  private cachedTokenInfo: {
    [chainId: string]: { [tokenAddress: number]: L1Token };
  } = {};

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

  async checkUtilization(): Promise<void> {
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

  async checkUnknownRelayers(): Promise<void> {
    const chainIds = this.monitorConfig.spokePoolChains;
    this.logger.debug({ at: "AcrossMonitor#UnknownRelayers", message: "Checking for unknown relayers", chainIds });
    for (const chainId of chainIds) {
      const fills = await this.clients.spokePoolClients[chainId].getFillsWithBlockInRange(
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

  // Report balances of all tokens on each supported chain for each relayer.
  async reportRelayerBalances(): Promise<void> {
    const relayers = this.monitorConfig.monitoredRelayers;
    for (const relayer of relayers) {
      for (const chainId of this.monitorConfig.spokePoolChains) {
        const tokenAddresses = this.clients.hubPoolClient.getDestinationTokensForChainId(chainId);

        // Use the provider from the spoke pool to send requests to the right provider.
        const spokePoolClient = this.clients.spokePoolClients[chainId];
        const tokenBalances = await Promise.all(
          tokenAddresses.map((tokenAddress) =>
            new Contract(tokenAddress, ERC20.abi, spokePoolClient.spokePool.signer).balanceOf(relayer)
          )
        );

        let mrkdwn = "";
        for (let i = 0; i < tokenAddresses.length; i++) {
          const tokenInfo = this.clients.hubPoolClient.getL1TokenInfoForL2Token(tokenAddresses[i], chainId);
          // Convert to number of tokens for readability.
          const balance = convertFromWei(tokenBalances[i], tokenInfo.decimals);
          mrkdwn += `*${tokenInfo.symbol}: ${balance}*\n`;
        }

        this.logger.info({
          at: "Monitor",
          message: `Relayer (${relayer})'s token balances for chain ${chainId} 🚀`,
          mrkdwn,
        });
      }
    }
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

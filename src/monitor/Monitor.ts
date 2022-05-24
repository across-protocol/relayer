import { MonitorClients } from "../clients/MonitorClientHelper";
import { etherscanLink, toBN, toWei, winston, createFormatFunction, getNetworkName, providers } from "../utils";
import { MonitorConfig } from "./MonitorConfig";
import { RelayerProcessor } from "./RelayerProcessor";
import { EventInfo, RootBundleProcessor } from "./RootBundleProcessor";

export class Monitor {
  // Block range to search is only defined on calling update().
  private hubPoolStartingBlock: number | undefined = undefined;
  private hubPoolEndingBlock: number | undefined = undefined;
  private spokePoolsBlocks: Record<number, { startingBlock: number | undefined; endingBlock: number | undefined }> = {};
  // relayEventProcessor Module used to fetch and process relay events.
  private rootBundleProcessor: RootBundleProcessor;
  private relayerProcessor: RelayerProcessor;

  public constructor(
    readonly logger: winston.Logger,
    readonly monitorConfig: MonitorConfig,
    readonly clients: MonitorClients
  ) {
    this.rootBundleProcessor = new RootBundleProcessor(logger, clients.hubPoolClient);
    for (const chainId of Object.keys(clients.spokePools)) {
      this.spokePoolsBlocks[chainId] = { startingBlock: undefined, endingBlock: undefined };
    }
    this.relayerProcessor = new RelayerProcessor(logger);
  }

  public async update() {
    await this.clients.hubPoolClient.update();
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
        this.logger.warn({
          at: "UtilizationMonitor",
          message: "High pool utilization warning 🏊",
          mrkdwn,
          notificationPath: "across-monitor",
        });
      }
    }
  }

  async checkUnknownRootBundleCallers(): Promise<void> {
    this.logger.debug({ at: "AcrossMonitor#RootBundleCallers", message: "Checking for unknown root bundle callers" });

    const rootBundleEvents: EventInfo[] = await this.rootBundleProcessor.getRootBundleEventsInfo(
      this.hubPoolStartingBlock,
      this.hubPoolEndingBlock
    );
    for (const event of rootBundleEvents) {
      if (this.monitorConfig.whitelistedDataworkers.includes(event.caller)) {
        continue;
      }

      const mrkdwn = `${etherscanLink(event.caller, this.monitorConfig.hubPoolChainId)}
       ${event.action} on ${getNetworkName(this.monitorConfig.hubPoolChainId)}`;
      this.logger.warn({
        at: "UnknownRootBundleCaller",
        message: "Across Hub Pool unknown root bundle caller warning 🥷",
        mrkdwn,
        notificationPath: "across-monitor",
      });
    }
  }

  async checkUnknownRelayers(): Promise<void> {
    this.logger.debug({ at: "AcrossMonitor#UnknownRelayers", message: "Checking for unknown relayers" });

    for (const chainId of Object.keys(this.clients.spokePools)) {
      console.log("chainId", chainId);
      console.log("RANGE", this.spokePoolsBlocks[chainId].startingBlock, this.spokePoolsBlocks[chainId].endingBlock);
      const relayEvents: EventInfo[] = await this.relayerProcessor.getRelayedEventsInfo(
        this.clients.spokePools[chainId],
        this.spokePoolsBlocks[chainId].startingBlock,
        this.spokePoolsBlocks[chainId].endingBlock
      );
      for (const event of relayEvents) {
        console.log("event", event);
        // Skip notifications for known relay caller addresses.
        if (this.monitorConfig.whitelistedRelayers.includes(event.caller)) {
          continue;
        }
        const mrkdwn = `${etherscanLink(event.caller, parseInt(chainId))} ${event.action} on 
          ${getNetworkName(chainId)}`;
        this.logger.warn({
          at: "UnknownRelayer",
          message: "Across Spoke Pool unknown relayer warning 🕺",
          mrkdwn,
          notificationPath: "across-monitor",
        });
      }
    }
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
    for (const chainId of Object.keys(this.clients.spokePools)) {
      const { startingBlock, endingBlock } = await this.computeStartingAndEndingBlock(
        this.clients.spokePools[chainId].provider,
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

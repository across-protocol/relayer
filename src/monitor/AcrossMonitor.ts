import { SpokePool } from "@across-protocol/contracts-v2";
import { createEtherscanLinkMarkdown, createFormatFunction, PublicNetworks } from "@uma/common";
import { providers } from "ethers";
import { HubPoolClient } from "../clients";
import { toBN, toWei, winston } from "../utils";
import { AcrossMonitorConfig } from "./AcrossMonitorConfig";
import { RelayerProcessor } from "./RelayerProcessor";
import { EventInfo, RootBundleProcessor } from "./RootBundleProcessor";

export class AcrossMonitor {
  // Block range to search is only defined on calling update().
  private hubPoolStartingBlock: number | undefined = undefined;
  private hubPoolEndingBlock: number | undefined = undefined;
  private spokePoolsBlocks: Record<number, { startingBlock: number | undefined; endingBlock: number | undefined }> = {};
  // relayEventProcessor Module used to fetch and process relay events.
  private rootBundleProcessor: RootBundleProcessor;
  private relayerProcessor: RelayerProcessor;

  public constructor(
    readonly logger: winston.Logger,
    readonly monitorConfig: AcrossMonitorConfig,
    readonly hubPoolClient: HubPoolClient,
    readonly spokePools: Record<number, SpokePool>
  ) {
    this.rootBundleProcessor = new RootBundleProcessor(hubPoolClient, logger);
    for (const chainId of Object.keys(spokePools)) {
      this.spokePoolsBlocks[chainId] = { startingBlock: undefined, endingBlock: undefined };
    }
    this.relayerProcessor = new RelayerProcessor(logger);
  }

  public async update() {
    await this.hubPoolClient.update();
    await this.computeHubPoolBlocks();
    await this.computeSpokePoolsBlocks();
  }

  async checkUtilization(): Promise<void> {
    this.logger.debug({ at: "AcrossMonitor#Utilization", message: "Checking for pool utilization ratio" });
    const l1Tokens = Object.keys(this.hubPoolClient.getL1Tokens());
    const utilizations = await Promise.all(
      l1Tokens.map(async (l1Token) => {
        const utilization = await this.hubPoolClient.getCurrentPoolUtilization(l1Token);
        return {
          address: l1Token,
          chainId: this.monitorConfig.hubPoolChainId,
          poolCollateralSymbol: this.hubPoolClient.getTokenInfoForL1Token(l1Token).symbol,
          utilization: utilization,
        };
      })
    );

    // Send notification if pool utilization is above configured threshold.
    for (const utilization of utilizations) {
      if (
        toBN(utilization.utilization).gt(
          toBN(this.monitorConfig.utilizationThreshold)
            .mul(toBN(toWei("1")))
            .div(toBN(100))
        )
      ) {
        const utilizationString = toBN(utilization.utilization as string)
          .mul(toBN(100))
          .toString();
        this.logger.warn({
          at: "UtilizationMonitor",
          message: "High pool utilization warning 🏊",
          mrkdwn:
            utilization.poolCollateralSymbol +
            " bridge pool at " +
            createEtherscanLinkMarkdown(utilization.address, utilization.chainId) +
            " on " +
            PublicNetworks[utilization.chainId]?.name +
            " is at " +
            createFormatFunction(0, 2)(utilizationString) +
            "% utilization!",
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
      if (this.monitorConfig.whitelistedAddresses.includes(event.caller)) {
        continue;
      }

      this.logger.warn({
        at: "UnknownRootBundleCaller",
        message: "Across Hub Pool unknown root bundle caller warning 🥷",
        mrkdwn:
          createEtherscanLinkMarkdown(event.caller, this.monitorConfig.hubPoolChainId) +
          " " +
          event.action +
          " on " +
          PublicNetworks[this.monitorConfig.hubPoolChainId].name,
        notificationPath: "across-monitor",
      });
    }
  }

  async checkUnknownRelayers(): Promise<void> {
    this.logger.debug({ at: "AcrossMonitor#UnknownRelayers", message: "Checking for unknown relayers" });

    for (const chainId of Object.keys(this.spokePools)) {
      const relayEvents: EventInfo[] = await this.relayerProcessor.getRelayedEventsInfo(
        this.spokePools[chainId],
        this.spokePoolsBlocks[chainId].startingBlock,
        this.spokePoolsBlocks[chainId].endingBlock
      );
      for (const event of relayEvents) {
        // Skip notifications for known relay caller addresses.
        if (this.monitorConfig.whitelistedRelayers.includes(event.caller)) {
          continue;
        }

        this.logger.warn({
          at: "UnknownRelayer",
          message: "Across Spoke Pool unknown relayer warning 🥷",
          mrkdwn:
            createEtherscanLinkMarkdown(event.caller, parseInt(chainId)) +
            " " +
            event.action +
            " on " +
            PublicNetworks[this.monitorConfig.hubPoolChainId].name,
          notificationPath: "across-monitor",
        });
      }
    }
  }

  private async computeHubPoolBlocks() {
    const { startingBlock, endingBlock } = await this.computeStartingAndEndingBlock(
      this.hubPoolClient.hubPool.provider,
      this.monitorConfig.hubPoolStartingBlock,
      this.monitorConfig.hubPoolEndingBlock
    );
    this.hubPoolStartingBlock = startingBlock;
    this.hubPoolEndingBlock = endingBlock;
  }

  private async computeSpokePoolsBlocks() {
    for (const chainId of Object.keys(this.spokePools)) {
      const { startingBlock, endingBlock } = await this.computeStartingAndEndingBlock(
        this.spokePools[chainId].provider,
        this.monitorConfig.spokePoolsBlocks[chainId].startingBlock,
        this.monitorConfig.spokePoolsBlocks[chainId].endingBlock
      );

      this.spokePoolsBlocks[chainId].startingBlock = startingBlock;
      this.spokePoolsBlocks[chainId].endingBlock = endingBlock;
    }
  }

  // Compute the starting and ending block for each chain giving the provider and the config values
  private async computeStartingAndEndingBlock(
    provider: providers.Provider,
    startingBlock: number | undefined,
    endingBlock: number | undefined
  ) {
    // In serverless mode (pollingDelay === 0) use block range from environment (or just the latest block if not
    // provided) to fetch for latest events.
    // Else, if running in loop mode (pollingDelay != 0), start with the latest block and on next loops continue from
    // where the last one ended.
    const latestBlockNumber = (await provider.getBlock("latest")).number;
    let finalStartingBlock: number;
    let finalEndingBlock: number;

    if (this.monitorConfig.pollingDelay === 0) {
      finalStartingBlock = startingBlock !== undefined ? startingBlock : latestBlockNumber;
      finalEndingBlock = endingBlock !== undefined ? endingBlock : latestBlockNumber;
    } else {
      finalStartingBlock = endingBlock ? endingBlock + 1 : latestBlockNumber;
      finalEndingBlock = latestBlockNumber;
    }

    // Starting block should not be after the ending block (this could happen on short polling period or
    // misconfiguration).
    finalStartingBlock = Math.min(finalStartingBlock, finalEndingBlock);

    return {
      startingBlock: finalStartingBlock,
      endingBlock: finalEndingBlock,
    };
  }
}

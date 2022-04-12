import { createEtherscanLinkMarkdown, createFormatFunction, PublicNetworks } from "@uma/common";
import { HubPoolClient } from "../clients";
import { toBN, toWei, winston } from "../utils";
import { AcrossMonitorConfig } from "./AcrossMonitorConfig";
import { RelayEventProcessor } from "./RelayEventProcessor";

export class AcrossMonitor {
  // Block range to search is only defined on calling update().
  private startingBlock: number | undefined = undefined;
  private endingBlock: number | undefined = undefined;

  // relayEventProcessor Module used to fetch and process relay events.
  private relayEventProcessor: RelayEventProcessor;

  public constructor(
    readonly logger: winston.Logger,
    readonly monitorConfig: AcrossMonitorConfig,
    readonly hubPoolClient: HubPoolClient
  ) {
    this.relayEventProcessor = new RelayEventProcessor();
  }

  public async update() {
    await this.hubPoolClient.update();
    // In serverless mode (pollingDelay === 0) use block range from environment (or just the latest block if not
    // provided) to fetch for latest events.
    // Else, if running in loop mode (pollingDelay != 0), start with the latest block and on next loops continue from
    // where the last one ended.
    const latestL1BlockNumber = (await this.hubPoolClient.hubPool.provider.getBlock("latest")).number;

    if (this.monitorConfig.pollingDelay === 0) {
      this.startingBlock =
        this.monitorConfig.startingBlock !== undefined ? this.monitorConfig.startingBlock : latestL1BlockNumber;
      this.endingBlock =
        this.monitorConfig.endingBlock !== undefined ? this.monitorConfig.endingBlock : latestL1BlockNumber;
    } else {
      this.startingBlock = this.endingBlock ? this.endingBlock + 1 : latestL1BlockNumber;
      this.endingBlock = latestL1BlockNumber;
    }

    // Starting block should not be after the ending block (this could happen on short polling period or
    // misconfiguration).
    this.startingBlock = Math.min(this.startingBlock, this.endingBlock);

    await this.relayEventProcessor.update(this.endingBlock);
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
}

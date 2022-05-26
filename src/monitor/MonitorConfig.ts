import { CommonConfig, ProcessEnv } from "../common";
import { ethers } from "../utils";

// Set modes to true that you want to enable in the AcrossMonitor bot.
export interface BotModes {
  utilizationEnabled: boolean; // Monitors pool utilization ratio
  unknownRootBundleCallersEnabled: boolean; // Monitors relay related events triggered by non-whitelisted addresses
  unknownRelayerCallersEnabled: boolean;
}

export class MonitorConfig extends CommonConfig {
  readonly spokePoolsBlocks: Record<number, { startingBlock: number | undefined; endingBlock: number | undefined }> =
    {};

  readonly utilizationThreshold: number;
  readonly hubPoolStartingBlock: number | undefined;
  readonly hubPoolEndingBlock: number | undefined;
  readonly whitelistedDataworkers: string[];
  readonly whitelistedRelayers: string[];
  readonly botModes: BotModes;

  constructor(env: ProcessEnv) {
    super(env);

    const {
      STARTING_BLOCK_NUMBER,
      ENDING_BLOCK_NUMBER,
      UTILIZATION_ENABLED,
      UNKNOWN_ROOT_BUNDLE_CALLERS_ENABLED,
      UNKNOWN_RELAYER_CALLERS_ENABLED,
      UTILIZATION_THRESHOLD,
      WHITELISTED_DATA_WORKERS,
      WHITELISTED_RELAYERS,
    } = env;

    this.botModes = {
      utilizationEnabled: UTILIZATION_ENABLED === "true",
      unknownRootBundleCallersEnabled: UNKNOWN_ROOT_BUNDLE_CALLERS_ENABLED === "true",
      unknownRelayerCallersEnabled: UNKNOWN_RELAYER_CALLERS_ENABLED === "true",
    };

    this.whitelistedDataworkers = WHITELISTED_DATA_WORKERS ? JSON.parse(WHITELISTED_DATA_WORKERS) : [];
    for (let i = 0; i < this.whitelistedDataworkers.length; i++) {
      this.whitelistedDataworkers[i] = ethers.utils.getAddress(this.whitelistedDataworkers[i]);
    }

    this.whitelistedRelayers = WHITELISTED_RELAYERS ? JSON.parse(WHITELISTED_RELAYERS) : [];
    for (let i = 0; i < this.whitelistedRelayers.length; i++) {
      this.whitelistedRelayers[i] = ethers.utils.getAddress(this.whitelistedRelayers[i]);
    }

    // Default pool utilization threshold at 90%.
    this.utilizationThreshold = UTILIZATION_THRESHOLD ? Number(UTILIZATION_THRESHOLD) : 90;

    if (this.utilizationThreshold > 100) throw new Error("UTILIZATION_THRESHOLD must be <= 100");
    if (this.utilizationThreshold < 0) throw new Error("UTILIZATION_THRESHOLD must be >= 0");

    // In serverless mode use block range from environment to fetch for latest events.
    this.hubPoolStartingBlock = STARTING_BLOCK_NUMBER ? Number(STARTING_BLOCK_NUMBER) : undefined;
    this.hubPoolEndingBlock = ENDING_BLOCK_NUMBER ? Number(ENDING_BLOCK_NUMBER) : undefined;

    if (UNKNOWN_RELAYER_CALLERS_ENABLED)
      this.spokePoolChains.forEach((chainId) => {
        this.spokePoolsBlocks[chainId] = {
          startingBlock: process.env[`STARTING_BLOCK_NUMBER_${chainId}`]
            ? Number(process.env[`STARTING_BLOCK_NUMBER_${chainId}`])
            : undefined,
          endingBlock: process.env[`ENDING_BLOCK_NUMBER_${chainId}`]
            ? Number(process.env[`ENDING_BLOCK_NUMBER_${chainId}`])
            : undefined,
        };
      });
  }
}

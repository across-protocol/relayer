import { ethers } from "ethers";

export interface ProcessEnv {
  [key: string]: string | undefined;
}

// Set modes to true that you want to enable in the AcrossMonitor bot.
export interface BotModes {
  utilizationEnabled: boolean; // Monitors pool utilization ratio
  unknownRootBundleCallersEnabled: boolean; // Monitors relay related events triggered by non-whitelisted addresses
}

export class AcrossMonitorConfig {
  readonly errorRetries: number;
  readonly errorRetriesTimeout: number;
  readonly spokePoolChainIds: number[];
  readonly spokePoolsBlocks: Record<number, { startingBlock: number | undefined; endingBlock: number | undefined }>;
  readonly hubPoolChainId: number;
  readonly pollingDelay: number;
  readonly utilizationThreshold: number;
  readonly hubPoolStartingBlock: number | undefined;
  readonly hubPoolEndingBlock: number | undefined;
  readonly whitelistedAddresses: string[];
  readonly whitelistedRelayers: string[];
  readonly botModes: BotModes;

  public constructor(env: ProcessEnv) {
    const {
      POLLING_DELAY,
      HUBPOOL_STARTING_BLOCK_NUMBER,
      HUBPOOL_ENDING_BLOCK_NUMBER,
      UTILIZATION_ENABLED,
      UNKNOWN_ROOT_BUNDLE_CALLERS_ENABLED,
      HUB_CHAIN_ID,
      UTILIZATION_THRESHOLD,
      WHITELISTED_ADDRESSES,
      SPOKE_POOL_CHAIN_IDS,
      SPOKE_POOLS_BLOCKS,
      WHITELISTED_RELAYERS,
      ERROR_RETRIES,
      ERROR_RETRIES_TIMEOUT,
    } = env;

    this.hubPoolChainId = HUB_CHAIN_ID ? Number(HUB_CHAIN_ID) : 1;
    this.botModes = {
      utilizationEnabled: UTILIZATION_ENABLED === "true",
      unknownRootBundleCallersEnabled: UNKNOWN_ROOT_BUNDLE_CALLERS_ENABLED === "true",
    };

    this.whitelistedAddresses = WHITELISTED_ADDRESSES ? JSON.parse(WHITELISTED_ADDRESSES) : [];
    for (let i = 0; i < this.whitelistedAddresses.length; i++) {
      this.whitelistedAddresses[i] = ethers.utils.getAddress(this.whitelistedAddresses[i]);
    }

    this.whitelistedRelayers = WHITELISTED_RELAYERS ? JSON.parse(WHITELISTED_RELAYERS) : [];
    for (let i = 0; i < this.whitelistedRelayers.length; i++) {
      this.whitelistedRelayers[i] = ethers.utils.getAddress(this.whitelistedRelayers[i]);
    }

    // Default pool utilization threshold at 90%.
    this.utilizationThreshold = UTILIZATION_THRESHOLD ? Number(UTILIZATION_THRESHOLD) : 90;

    if (this.utilizationThreshold > 100) throw new Error("UTILIZATION_THRESHOLD must be <= 100");
    if (this.utilizationThreshold < 0) throw new Error("UTILIZATION_THRESHOLD must be >= 0");

    this.pollingDelay = POLLING_DELAY ? Number(POLLING_DELAY) : 60;

    // In serverless mode use block range from environment to fetch for latest events.
    this.hubPoolStartingBlock = HUBPOOL_STARTING_BLOCK_NUMBER ? Number(HUBPOOL_STARTING_BLOCK_NUMBER) : undefined;
    this.hubPoolEndingBlock = HUBPOOL_ENDING_BLOCK_NUMBER ? Number(HUBPOOL_ENDING_BLOCK_NUMBER) : undefined;

    this.spokePoolChainIds = SPOKE_POOL_CHAIN_IDS ? JSON.parse(SPOKE_POOL_CHAIN_IDS) : [1, 10, 42161, 288];
    this.spokePoolsBlocks = SPOKE_POOLS_BLOCKS ? JSON.parse(SPOKE_POOLS_BLOCKS) : {};

    this.errorRetries = ERROR_RETRIES ? Number(ERROR_RETRIES) : 3;
    this.errorRetriesTimeout = ERROR_RETRIES_TIMEOUT ? Number(ERROR_RETRIES_TIMEOUT) : 1;
  }
}

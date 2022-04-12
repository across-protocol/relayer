export interface ProcessEnv {
  [key: string]: string | undefined;
}

// Set modes to true that you want to enable in the AcrossMonitor bot.
export interface BotModes {
  utilizationEnabled: boolean; // Monitors pool utilization ratio
  unknownRelayersEnabled: boolean; // Monitors relay related events triggered by non-whitelisted addresses
}

export class AcrossMonitorConfig {
  readonly hubPoolChainId: number;
  readonly pollingDelay: number;
  readonly utilizationThreshold: number;
  readonly startingBlock: number | undefined;
  readonly endingBlock: number | undefined;

  readonly botModes: BotModes;

  public constructor(env: ProcessEnv) {
    const {
      POLLING_DELAY,
      STARTING_BLOCK_NUMBER,
      ENDING_BLOCK_NUMBER,
      UTILIZATION_ENABLED,
      UNKNOWN_RELAYERS_ENABLED,
      HUB_CHAIN_ID,
      UTILIZATION_THRESHOLD,
    } = env;

    this.hubPoolChainId = HUB_CHAIN_ID ? Number(HUB_CHAIN_ID) : 1;
    this.botModes = {
      utilizationEnabled: UTILIZATION_ENABLED === "true",
      unknownRelayersEnabled: UNKNOWN_RELAYERS_ENABLED === "true",
    };

    // Default pool utilization threshold at 90%.
    this.utilizationThreshold = UTILIZATION_THRESHOLD ? Number(UTILIZATION_THRESHOLD) : 90;

    if (this.utilizationThreshold > 100) throw new Error("UTILIZATION_THRESHOLD must be <= 100");
    if (this.utilizationThreshold < 0) throw new Error("UTILIZATION_THRESHOLD must be >= 0");

    this.pollingDelay = POLLING_DELAY ? Number(POLLING_DELAY) : 60;

    // In serverless mode use block range from environment to fetch for latest events.
    this.startingBlock = STARTING_BLOCK_NUMBER ? Number(STARTING_BLOCK_NUMBER) : undefined;
    this.endingBlock = ENDING_BLOCK_NUMBER ? Number(ENDING_BLOCK_NUMBER) : undefined;
  }
}

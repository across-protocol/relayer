import { CommonConfig, ProcessEnv } from "../common";
import { ethers, BigNumber, ZERO_ADDRESS } from "../utils";

// Set modes to true that you want to enable in the AcrossMonitor bot.
export interface BotModes {
  utilizationEnabled: boolean; // Monitors pool utilization ratio
  unknownRootBundleCallersEnabled: boolean; // Monitors relay related events triggered by non-whitelisted addresses
  unknownRelayerCallersEnabled: boolean;
  reportEnabled: boolean;
  balancesEnabled: boolean;
}

export class MonitorConfig extends CommonConfig {
  readonly spokePoolsBlocks: Record<number, { startingBlock: number | undefined; endingBlock: number | undefined }> =
    {};

  readonly utilizationThreshold: number;
  readonly hubPoolStartingBlock: number | undefined;
  readonly hubPoolEndingBlock: number | undefined;
  readonly monitorReportInterval: number;
  readonly monitoredRelayers: string[];
  readonly whitelistedDataworkers: string[];
  readonly whitelistedRelayers: string[];
  readonly knownV1Addresses: string[];
  readonly botModes: BotModes;
  readonly monitoredBalances: { chainId: number; threshold: number; account: string; token: string }[] = [];

  constructor(env: ProcessEnv) {
    super(env);

    const {
      STARTING_BLOCK_NUMBER,
      ENDING_BLOCK_NUMBER,
      MONITORED_RELAYERS,
      MONITOR_REPORT_ENABLED,
      UTILIZATION_ENABLED,
      UNKNOWN_ROOT_BUNDLE_CALLERS_ENABLED,
      UNKNOWN_RELAYER_CALLERS_ENABLED,
      UTILIZATION_THRESHOLD,
      WHITELISTED_DATA_WORKERS,
      WHITELISTED_RELAYERS,
      KNOWN_V1_ADDRESSES,
      BALANCES_ENABLED,
      MONITORED_BALANCES,
    } = env;

    this.botModes = {
      utilizationEnabled: UTILIZATION_ENABLED === "true",
      unknownRootBundleCallersEnabled: UNKNOWN_ROOT_BUNDLE_CALLERS_ENABLED === "true",
      unknownRelayerCallersEnabled: UNKNOWN_RELAYER_CALLERS_ENABLED === "true",
      reportEnabled: MONITOR_REPORT_ENABLED === "true",
      balancesEnabled: BALANCES_ENABLED === "true",
    };

    // Used to monitor activities not from whitelisted data workers or relayers.
    this.whitelistedDataworkers = parseAddressesOptional(WHITELISTED_DATA_WORKERS);
    this.whitelistedRelayers = parseAddressesOptional(WHITELISTED_RELAYERS);

    // Used to monitor balances, activities, etc. from the specified relayers.
    this.monitoredRelayers = parseAddressesOptional(MONITORED_RELAYERS);
    this.knownV1Addresses = parseAddressesOptional(KNOWN_V1_ADDRESSES);

    // Default pool utilization threshold at 90%.
    this.utilizationThreshold = UTILIZATION_THRESHOLD ? Number(UTILIZATION_THRESHOLD) : 90;

    if (this.utilizationThreshold > 100) throw new Error("UTILIZATION_THRESHOLD must be <= 100");
    if (this.utilizationThreshold < 0) throw new Error("UTILIZATION_THRESHOLD must be >= 0");

    // In serverless mode use block range from environment to fetch for latest events.
    this.hubPoolStartingBlock = STARTING_BLOCK_NUMBER ? Number(STARTING_BLOCK_NUMBER) : undefined;
    this.hubPoolEndingBlock = ENDING_BLOCK_NUMBER ? Number(ENDING_BLOCK_NUMBER) : undefined;

    if (MONITORED_BALANCES) {
      this.monitoredBalances = JSON.parse(MONITORED_BALANCES).map(({ threshold, account, token, chainId }) => {
        if (Number.isNaN(Number(threshold))) throw new Error(`amount value: ${threshold} cannot be converted to a number`);
        if (Number.isNaN(parseInt(chainId)))
          throw new Error(`chainId value: ${chainId} cannot be converted to an integer`);
        const isNativeToken = !token || token === "0x0" || token === ZERO_ADDRESS;
        return {
          token: isNativeToken ? ZERO_ADDRESS : token,
          amount: Number(threshold),
          account: ethers.utils.getAddress(account),
          chainId: parseInt(chainId),
        };
      });
    }

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

const parseAddressesOptional = (addressJson?: string): string[] => {
  const rawAddresses: string[] = addressJson ? JSON.parse(addressJson) : [];
  return rawAddresses.map((address) => ethers.utils.getAddress(address));
};

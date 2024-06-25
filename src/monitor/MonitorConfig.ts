import { CommonConfig, ProcessEnv } from "../common";
import { ethers, getEthAddressForChain } from "../utils";

// Set modes to true that you want to enable in the AcrossMonitor bot.
export interface BotModes {
  balancesEnabled: boolean;
  refillBalancesEnabled: boolean;
  reportEnabled: boolean;
  stuckRebalancesEnabled: boolean;
  utilizationEnabled: boolean; // Monitors pool utilization ratio
  unknownRootBundleCallersEnabled: boolean; // Monitors relay related events triggered by non-whitelisted addresses
}

export class MonitorConfig extends CommonConfig {
  public spokePoolsBlocks: Record<number, { startingBlock: number | undefined; endingBlock: number | undefined }> = {};

  readonly utilizationThreshold: number;
  readonly hubPoolStartingBlock: number | undefined;
  readonly hubPoolEndingBlock: number | undefined;
  readonly stuckRebalancesEnabled: boolean;
  readonly monitoredRelayers: string[];
  readonly whitelistedDataworkers: string[];
  readonly whitelistedRelayers: string[];
  readonly knownV1Addresses: string[];
  readonly botModes: BotModes;
  readonly refillEnabledBalances: {
    chainId: number;
    isHubPool: boolean;
    account: string;
    token: string;
    target: number;
    trigger: number;
  }[] = [];
  readonly monitoredBalances: {
    chainId: number;
    warnThreshold: number | null;
    errorThreshold: number | null;
    account: string;
    token: string;
  }[] = [];

  // TODO: Remove this config once we fully migrate to generic adapters.
  readonly useGenericAdapter: boolean;

  constructor(env: ProcessEnv) {
    super(env);

    const {
      STARTING_BLOCK_NUMBER,
      ENDING_BLOCK_NUMBER,
      MONITORED_RELAYERS,
      MONITOR_REPORT_ENABLED,
      UTILIZATION_ENABLED,
      UNKNOWN_ROOT_BUNDLE_CALLERS_ENABLED,
      UTILIZATION_THRESHOLD,
      WHITELISTED_DATA_WORKERS,
      WHITELISTED_RELAYERS,
      KNOWN_V1_ADDRESSES,
      BALANCES_ENABLED,
      MONITORED_BALANCES,
      REFILL_BALANCES,
      REFILL_BALANCES_ENABLED,
      STUCK_REBALANCES_ENABLED,
      MONITOR_USE_GENERIC_ADAPTER,
    } = env;

    this.botModes = {
      balancesEnabled: BALANCES_ENABLED === "true",
      refillBalancesEnabled: REFILL_BALANCES_ENABLED === "true",
      reportEnabled: MONITOR_REPORT_ENABLED === "true",
      utilizationEnabled: UTILIZATION_ENABLED === "true",
      unknownRootBundleCallersEnabled: UNKNOWN_ROOT_BUNDLE_CALLERS_ENABLED === "true",
      stuckRebalancesEnabled: STUCK_REBALANCES_ENABLED === "true",
    };

    this.useGenericAdapter = MONITOR_USE_GENERIC_ADAPTER === "true";

    // Used to monitor activities not from whitelisted data workers or relayers.
    this.whitelistedDataworkers = parseAddressesOptional(WHITELISTED_DATA_WORKERS);
    this.whitelistedRelayers = parseAddressesOptional(WHITELISTED_RELAYERS);

    // Used to monitor balances, activities, etc. from the specified relayers.
    this.monitoredRelayers = parseAddressesOptional(MONITORED_RELAYERS);
    this.knownV1Addresses = parseAddressesOptional(KNOWN_V1_ADDRESSES);

    // Used to send tokens if available in wallet to balances under target balances.
    if (REFILL_BALANCES) {
      this.refillEnabledBalances = JSON.parse(REFILL_BALANCES).map(
        ({ chainId, account, isHubPool, target, trigger }) => {
          if (Number.isNaN(target) || target <= 0) {
            throw new Error(`target for ${chainId} and ${account} must be > 0, got ${target}`);
          }
          if (Number.isNaN(trigger) || trigger <= 0) {
            throw new Error(`trigger for ${chainId} and ${account} must be > 0, got ${trigger}`);
          }
          if (trigger >= target) {
            throw new Error("trigger must be < target");
          }
          return {
            // Required fields:
            chainId,
            account,
            target,
            trigger,
            // Optional fields that will set to defaults:
            isHubPool: Boolean(isHubPool),
            // Fields that are always set to defaults:
            token: getEthAddressForChain(chainId),
          };
        }
      );
    }

    // Should only have 1 HubPool.
    if (Object.values(this.refillEnabledBalances).filter((x) => x.isHubPool).length > 1) {
      throw new Error("REFILL_BALANCES should only have 1 account marked isHubPool as true");
    }

    // Default pool utilization threshold at 90%.
    this.utilizationThreshold = UTILIZATION_THRESHOLD ? Number(UTILIZATION_THRESHOLD) : 90;

    if (this.utilizationThreshold > 100) {
      throw new Error("UTILIZATION_THRESHOLD must be <= 100");
    }
    if (this.utilizationThreshold < 0) {
      throw new Error("UTILIZATION_THRESHOLD must be >= 0");
    }

    // In serverless mode use block range from environment to fetch for latest events.
    this.hubPoolStartingBlock = STARTING_BLOCK_NUMBER ? Number(STARTING_BLOCK_NUMBER) : undefined;
    this.hubPoolEndingBlock = ENDING_BLOCK_NUMBER ? Number(ENDING_BLOCK_NUMBER) : undefined;

    if (MONITORED_BALANCES) {
      this.monitoredBalances = JSON.parse(MONITORED_BALANCES).map(
        ({ errorThreshold, warnThreshold, account, token, chainId }) => {
          if (!errorThreshold && !warnThreshold) {
            throw new Error("Must provide either an errorThreshold or a warnThreshold");
          }

          let parsedErrorThreshold: number | null = null;
          if (errorThreshold) {
            if (Number.isNaN(Number(errorThreshold))) {
              throw new Error(`errorThreshold value: ${errorThreshold} cannot be converted to a number`);
            }
            parsedErrorThreshold = Number(errorThreshold);
          }

          let parsedWarnThreshold: number | null = null;
          if (warnThreshold) {
            if (Number.isNaN(Number(errorThreshold))) {
              throw new Error(`warnThreshold value: ${warnThreshold} cannot be converted to a number`);
            }
            parsedWarnThreshold = Number(warnThreshold);
          }

          const isNativeToken = !token || token === "0x0" || token === getEthAddressForChain(chainId);
          return {
            token: isNativeToken ? getEthAddressForChain(chainId) : token,
            errorThreshold: parsedErrorThreshold,
            warnThreshold: parsedWarnThreshold,
            account: ethers.utils.getAddress(account),
            chainId: parseInt(chainId),
          };
        }
      );
    }
  }

  loadAndValidateConfigForChains(chainIdIndices: number[]): void {
    // Min deposit confirmations seems like the most likely constant to have all possible chain IDs listed.
    chainIdIndices.forEach((chainId) => {
      this.spokePoolsBlocks[chainId] = {
        startingBlock: process.env[`STARTING_BLOCK_NUMBER_${chainId}`]
          ? Number(process.env[`STARTING_BLOCK_NUMBER_${chainId}`])
          : undefined,
        endingBlock: process.env[`ENDING_BLOCK_NUMBER_${chainId}`]
          ? Number(process.env[`ENDING_BLOCK_NUMBER_${chainId}`])
          : undefined,
      };
    });
    super.loadAndValidateConfigForChains(chainIdIndices);
  }
}

const parseAddressesOptional = (addressJson?: string): string[] => {
  const rawAddresses: string[] = addressJson ? JSON.parse(addressJson) : [];
  return rawAddresses.map((address) => ethers.utils.getAddress(address));
};

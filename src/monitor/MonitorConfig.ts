import winston from "winston";
import { MAINNET_CHAIN_IDs } from "@across-protocol/constants";
import { CommonConfig, ProcessEnv } from "../common";
import {
  CHAIN_IDs,
  getNativeTokenAddressForChain,
  isDefined,
  TOKEN_SYMBOLS_MAP,
  Address,
  toAddressType,
  EvmAddress,
} from "../utils";

// Interface for tokens that exist only on L2 (no L1 equivalent)
// @TODO: Move this to SDK
export interface L2Token {
  symbol: string;
  chainId: number;
  address: EvmAddress;
  decimals: number;
}

// Set modes to true that you want to enable in the AcrossMonitor bot.
export interface BotModes {
  balancesEnabled: boolean;
  reportEnabled: boolean;
  stuckRebalancesEnabled: boolean;
  utilizationEnabled: boolean; // Monitors pool utilization ratio
  unknownRootBundleCallersEnabled: boolean; // Monitors relay related events triggered by non-whitelisted addresses
  spokePoolBalanceReportEnabled: boolean;
  binanceWithdrawalLimitsEnabled: boolean;
  closePDAsEnabled: boolean;
  reportOpenHyperliquidOrders: boolean;
}

export class MonitorConfig extends CommonConfig {
  public spokePoolsBlocks: Record<number, { startingBlock: number | undefined; endingBlock: number | undefined }> = {};

  readonly utilizationThreshold: number;
  readonly hubPoolStartingBlock: number | undefined;
  readonly hubPoolEndingBlock: number | undefined;
  readonly stuckRebalancesEnabled: boolean;
  readonly monitoredRelayers: Address[];
  readonly monitoredSpokePoolChains: number[];
  readonly monitoredTokenSymbols: string[];
  readonly whitelistedDataworkers: Address[];
  readonly whitelistedRelayers: Address[];
  readonly knownV1Addresses: Address[];
  readonly bundlesCount: number;
  readonly botModes: BotModes;
  readonly monitoredBalances: {
    chainId: number;
    warnThreshold: number | null;
    errorThreshold: number | null;
    account: Address;
    token: Address;
  }[] = [];
  readonly additionalL1NonLpTokens: string[] = [];
  readonly l2OnlyTokens: L2Token[] = [];
  readonly binanceWithdrawWarnThreshold: number;
  readonly binanceWithdrawAlertThreshold: number;
  readonly hyperliquidOrderMaximumLifetime: number;
  readonly hyperliquidTokens: string[];
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
      MONITORED_BALANCES_2,
      STUCK_REBALANCES_ENABLED,
      REPORT_SPOKE_POOL_BALANCES,
      MONITORED_SPOKE_POOL_CHAINS,
      MONITORED_TOKEN_SYMBOLS,
      MONITOR_REPORT_NON_LP_TOKENS,
      BUNDLES_COUNT,
      MONITOR_USE_FOLLOW_DISTANCE,
      BINANCE_WITHDRAW_WARN_THRESHOLD,
      BINANCE_WITHDRAW_ALERT_THRESHOLD,
      CLOSE_PDAS_ENABLED,
      HYPERLIQUID_ORDER_MAXIMUM_LIFETIME,
      HYPERLIQUID_SUPPORTED_TOKENS,
      L2_ONLY_TOKENS,
    } = env;

    this.botModes = {
      balancesEnabled: BALANCES_ENABLED === "true",
      reportEnabled: MONITOR_REPORT_ENABLED === "true",
      utilizationEnabled: UTILIZATION_ENABLED === "true",
      unknownRootBundleCallersEnabled: UNKNOWN_ROOT_BUNDLE_CALLERS_ENABLED === "true",
      stuckRebalancesEnabled: STUCK_REBALANCES_ENABLED === "true",
      spokePoolBalanceReportEnabled: REPORT_SPOKE_POOL_BALANCES === "true",
      closePDAsEnabled: CLOSE_PDAS_ENABLED === "true",
      binanceWithdrawalLimitsEnabled:
        isDefined(BINANCE_WITHDRAW_WARN_THRESHOLD) || isDefined(BINANCE_WITHDRAW_ALERT_THRESHOLD),
      reportOpenHyperliquidOrders: isDefined(HYPERLIQUID_ORDER_MAXIMUM_LIFETIME),
    };

    if (MONITOR_USE_FOLLOW_DISTANCE !== "true") {
      Object.values(this.blockRangeEndBlockBuffer).forEach((chainId) => (this.blockRangeEndBlockBuffer[chainId] = 0));
    }

    // Used to monitor activities not from whitelisted data workers or relayers.
    this.whitelistedDataworkers = parseAddressesOptional(WHITELISTED_DATA_WORKERS);
    this.whitelistedRelayers = parseAddressesOptional(WHITELISTED_RELAYERS);
    this.monitoredRelayers = parseAddressesOptional(MONITORED_RELAYERS);
    this.knownV1Addresses = parseAddressesOptional(KNOWN_V1_ADDRESSES);
    this.monitoredSpokePoolChains = JSON.parse(MONITORED_SPOKE_POOL_CHAINS ?? "[]");
    this.monitoredTokenSymbols = JSON.parse(MONITORED_TOKEN_SYMBOLS ?? "[]");
    this.bundlesCount = Number(BUNDLES_COUNT ?? 4);
    this.additionalL1NonLpTokens = JSON.parse(MONITOR_REPORT_NON_LP_TOKENS ?? "[]").map((token) => {
      if (TOKEN_SYMBOLS_MAP[token]?.addresses?.[CHAIN_IDs.MAINNET]) {
        return TOKEN_SYMBOLS_MAP[token]?.addresses?.[CHAIN_IDs.MAINNET];
      }
    });

    // Parse L2-only tokens: tokens that exist only on L2 chains (no L1 equivalent).
    // Format: ["USDH", "OTHER_TOKEN"] - array of token symbols
    // - will look up token info from TOKEN_SYMBOLS_MAP
    // - will create entries for all chains in MAINNET_CHAIN_IDs where the token has an address
    // - all monitored relayers (MONITORED_RELAYERS) will be tracked for these tokens
    const l2OnlySymbols: string[] = JSON.parse(L2_ONLY_TOKENS ?? "[]");
    const mainnetChainIds = Object.values(MAINNET_CHAIN_IDs) as number[];
    this.l2OnlyTokens = l2OnlySymbols.flatMap((symbol) => {
      const tokenInfo = TOKEN_SYMBOLS_MAP[symbol];
      if (!tokenInfo?.addresses) {
        return [];
      }
      return mainnetChainIds
        .filter((chainId) => isDefined(tokenInfo.addresses[chainId]))
        .map((chainId) => ({
          symbol,
          chainId,
          address: EvmAddress.from(tokenInfo.addresses[chainId]),
          decimals: tokenInfo.decimals,
        }));
    });

    this.binanceWithdrawWarnThreshold = Number(BINANCE_WITHDRAW_WARN_THRESHOLD ?? 1);
    this.binanceWithdrawAlertThreshold = Number(BINANCE_WITHDRAW_ALERT_THRESHOLD ?? 1);

    this.hyperliquidTokens = JSON.parse(HYPERLIQUID_SUPPORTED_TOKENS ?? '["USDC", "USDT0", "USDH"]');
    this.hyperliquidOrderMaximumLifetime = Number(HYPERLIQUID_ORDER_MAXIMUM_LIFETIME ?? -1);

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

    const validate = (chainId: number, account: string, warnThreshold: number, errorThreshold: number) => {
      if (!isDefined(errorThreshold) && !isDefined(warnThreshold)) {
        throw new Error("Must provide either an errorThreshold or a warnThreshold");
      }

      if (isDefined(errorThreshold)) {
        if (Number.isNaN(Number(errorThreshold))) {
          throw new Error(`account ${account} ${chainId} errorThreshold not a number (${errorThreshold})`);
        }
      }

      if (isDefined(warnThreshold)) {
        if (Number.isNaN(Number(errorThreshold))) {
          throw new Error(`account ${account} ${chainId} warnThreshold not a number (${warnThreshold})`);
        }
      }
    };

    if (MONITORED_BALANCES_2) {
      this.monitoredBalances = [];
      const config = JSON.parse(MONITORED_BALANCES_2);
      Object.entries(config).forEach(([account, chainConfig]) => {
        Object.entries(chainConfig).forEach(([_chainId, tokenConfig]) => {
          const chainId = Number(_chainId);
          const { warnThreshold, errorThreshold, token } = tokenConfig;
          validate(chainId, account, warnThreshold, errorThreshold);
          this.monitoredBalances.push({
            chainId,
            account: toAddressType(account, chainId),
            warnThreshold,
            errorThreshold,
            token: isDefined(token) ? toAddressType(token, chainId) : getNativeTokenAddressForChain(chainId),
          });
        });
      });
    } else if (MONITORED_BALANCES) {
      this.monitoredBalances = JSON.parse(MONITORED_BALANCES).map(
        ({ errorThreshold, warnThreshold, account, token, chainId }) => {
          if (!isDefined(errorThreshold) && !isDefined(warnThreshold)) {
            throw new Error("Must provide either an errorThreshold or a warnThreshold");
          }

          let parsedErrorThreshold: number | null = null;
          if (isDefined(errorThreshold)) {
            if (Number.isNaN(Number(errorThreshold))) {
              throw new Error(`errorThreshold value: ${errorThreshold} cannot be converted to a number`);
            }
            parsedErrorThreshold = Number(errorThreshold);
          }

          let parsedWarnThreshold: number | null = null;
          if (isDefined(warnThreshold)) {
            if (Number.isNaN(Number(errorThreshold))) {
              throw new Error(`warnThreshold value: ${warnThreshold} cannot be converted to a number`);
            }
            parsedWarnThreshold = Number(warnThreshold);
          }

          const isNativeToken = !token || toAddressType(token, chainId).eq(getNativeTokenAddressForChain(chainId));
          return {
            token: isNativeToken ? getNativeTokenAddressForChain(chainId) : toAddressType(token, chainId),
            errorThreshold: parsedErrorThreshold,
            warnThreshold: parsedWarnThreshold,
            account: toAddressType(account, chainId),
            chainId: parseInt(chainId),
          };
        }
      );
    }
  }

  override validate(chainIds: number[], logger: winston.Logger): void {
    super.validate(chainIds, logger);

    // Min deposit confirmations seems like the most likely constant to have all possible chain IDs listed.
    chainIds.forEach((chainId) => {
      this.spokePoolsBlocks[chainId] = {
        startingBlock: Number(process.env[`STARTING_BLOCK_NUMBER_${chainId}`]) || undefined,
        endingBlock: Number(process.env[`ENDING_BLOCK_NUMBER_${chainId}`]) || undefined,
      };
    });
  }
}

const parseAddressesOptional = (addressJson?: string): Address[] => {
  const rawAddresses: string[] = addressJson ? JSON.parse(addressJson) : [];
  return rawAddresses.map((address) => {
    const chainId = address.startsWith("0x") ? CHAIN_IDs.MAINNET : CHAIN_IDs.SOLANA;
    return toAddressType(address, chainId);
  });
};

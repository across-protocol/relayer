import { utils as ethersUtils } from "ethers";
import winston from "winston";
import { typeguards } from "@across-protocol/sdk";
import {
  BigNumber,
  bnUint256Max,
  CHAIN_IDs,
  dedupArray,
  toBNWei,
  assert,
  getNetworkName,
  isDefined,
  readFileSync,
  toBN,
  replaceAddressCase,
  ethers,
  TESTNET_CHAIN_IDs,
  TOKEN_SYMBOLS_MAP,
} from "../utils";
import { CommonConfig, ProcessEnv } from "../common";
import * as Constants from "../common/Constants";
import { InventoryConfig, TokenBalanceConfig, isAliasConfig } from "../interfaces/InventoryManagement";

type DepositConfirmationConfig = {
  usdThreshold: BigNumber;
  minConfirmations: number;
};

export class RelayerConfig extends CommonConfig {
  readonly externalIndexer: boolean;
  readonly indexerPath: string;
  readonly inventoryConfig: InventoryConfig;
  readonly debugProfitability: boolean;
  // Whether token price fetch failures will be ignored when computing relay profitability.
  // If this is false, the relayer will throw an error when fetching prices fails.
  readonly skipRelays: boolean;
  readonly skipRebalancing: boolean;
  readonly sendingRelaysEnabled: boolean;
  readonly sendingRebalancesEnabled: boolean;
  readonly sendingMessageRelaysEnabled: boolean;
  readonly sendingSlowRelaysEnabled: boolean;
  readonly relayerTokens: string[];
  readonly relayerOriginChains: number[] = [];
  readonly relayerDestinationChains: number[] = [];
  readonly relayerGasPadding: BigNumber;
  readonly relayerGasMultiplier: BigNumber;
  readonly relayerMessageGasMultiplier: BigNumber;
  readonly minRelayerFeePct: BigNumber;
  readonly acceptInvalidFills: boolean;
  // List of depositors we only want to send slow fills for.
  readonly slowDepositors: string[];
  // Following distances in blocks to guarantee finality on each chain.
  readonly minDepositConfirmations: {
    [chainId: number]: DepositConfirmationConfig[];
  };
  // Set to false to skip querying max deposit limit from /limits Vercel API endpoint. Otherwise relayer will not
  // fill any deposit over the limit which is based on liquidReserves in the HubPool.
  readonly ignoreLimits: boolean;

  // TODO: Remove this config item once we fully move to generic chain adapters.
  readonly useGenericAdapter: boolean;

  constructor(env: ProcessEnv) {
    const {
      RELAYER_ORIGIN_CHAINS,
      RELAYER_DESTINATION_CHAINS,
      SLOW_DEPOSITORS,
      DEBUG_PROFITABILITY,
      RELAYER_GAS_MESSAGE_MULTIPLIER,
      RELAYER_GAS_MULTIPLIER,
      RELAYER_GAS_PADDING,
      RELAYER_EXTERNAL_INVENTORY_CONFIG,
      RELAYER_INVENTORY_CONFIG,
      RELAYER_TOKENS,
      SEND_RELAYS,
      SEND_REBALANCES,
      SEND_MESSAGE_RELAYS,
      SKIP_RELAYS,
      SKIP_REBALANCING,
      SEND_SLOW_RELAYS,
      MIN_RELAYER_FEE_PCT,
      ACCEPT_INVALID_FILLS,
      MIN_DEPOSIT_CONFIRMATIONS,
      RELAYER_IGNORE_LIMITS,
      RELAYER_EXTERNAL_INDEXER,
      RELAYER_SPOKEPOOL_INDEXER_PATH,
      RELAYER_USE_GENERIC_ADAPTER,
    } = env;
    super(env);

    this.useGenericAdapter = RELAYER_USE_GENERIC_ADAPTER === "true";

    // External indexing is dependent on looping mode being configured.
    this.externalIndexer = this.pollingDelay > 0 && RELAYER_EXTERNAL_INDEXER === "true";
    this.indexerPath = RELAYER_SPOKEPOOL_INDEXER_PATH ?? Constants.RELAYER_DEFAULT_SPOKEPOOL_INDEXER;

    // Empty means all chains.
    this.relayerOriginChains = JSON.parse(RELAYER_ORIGIN_CHAINS ?? "[]");
    this.relayerDestinationChains = JSON.parse(RELAYER_DESTINATION_CHAINS ?? "[]");

    // Empty means all tokens.
    this.relayerTokens = RELAYER_TOKENS
      ? JSON.parse(RELAYER_TOKENS).map((token) => ethers.utils.getAddress(token))
      : [];
    this.slowDepositors = SLOW_DEPOSITORS
      ? JSON.parse(SLOW_DEPOSITORS).map((depositor) => ethers.utils.getAddress(depositor))
      : [];

    this.minRelayerFeePct = toBNWei(MIN_RELAYER_FEE_PCT || Constants.RELAYER_MIN_FEE_PCT);

    assert(
      !isDefined(RELAYER_EXTERNAL_INVENTORY_CONFIG) || !isDefined(RELAYER_INVENTORY_CONFIG),
      "Concurrent inventory management configurations detected."
    );
    try {
      this.inventoryConfig = isDefined(RELAYER_EXTERNAL_INVENTORY_CONFIG)
        ? JSON.parse(readFileSync(RELAYER_EXTERNAL_INVENTORY_CONFIG))
        : JSON.parse(RELAYER_INVENTORY_CONFIG ?? "{}");
    } catch (err) {
      const msg = typeguards.isError(err) ? err.message : (err as Record<string, unknown>)?.code;
      throw new Error(`Inventory config error (${msg ?? "unknown error"})`);
    }

    if (Object.keys(this.inventoryConfig).length > 0) {
      this.inventoryConfig = replaceAddressCase(this.inventoryConfig); // Cast any non-address case addresses.

      const { inventoryConfig } = this;

      // Default to 1 Eth on the target chains and wrapping the rest to WETH.
      inventoryConfig.wrapEtherThreshold = toBNWei(inventoryConfig.wrapEtherThreshold ?? 1);

      inventoryConfig.wrapEtherThresholdPerChain ??= {};
      inventoryConfig.wrapEtherTarget = inventoryConfig.wrapEtherTarget
        ? toBNWei(inventoryConfig.wrapEtherTarget)
        : inventoryConfig.wrapEtherThreshold; // default to wrapping ETH to threshold, same as target.

      inventoryConfig.wrapEtherTargetPerChain ??= {};
      assert(
        inventoryConfig.wrapEtherThreshold.gte(inventoryConfig.wrapEtherTarget),
        `default wrapEtherThreshold ${inventoryConfig.wrapEtherThreshold} must be >= default wrapEtherTarget ${inventoryConfig.wrapEtherTarget}`
      );

      // Validate the per chain target and thresholds for wrapping ETH:
      const wrapThresholds = inventoryConfig.wrapEtherThresholdPerChain;
      const wrapTargets = inventoryConfig.wrapEtherTargetPerChain;
      Object.keys(inventoryConfig.wrapEtherThresholdPerChain).forEach((chainId) => {
        if (wrapThresholds[chainId] !== undefined) {
          wrapThresholds[chainId] = toBNWei(wrapThresholds[chainId]); // Promote to 18 decimals.
        }
      });

      Object.keys(inventoryConfig.wrapEtherTargetPerChain).forEach((chainId) => {
        if (wrapTargets[chainId] !== undefined) {
          wrapTargets[chainId] = toBNWei(wrapTargets[chainId]); // Promote to 18 decimals.

          // Check newly set target against threshold
          const threshold = wrapThresholds[chainId] ?? inventoryConfig.wrapEtherThreshold;
          const target = wrapTargets[chainId];
          assert(
            threshold.gte(target),
            `Chain ${chainId} wrapEtherThresholdPerChain ${threshold} must be >= wrapEtherTargetPerChain ${target}`
          );
        }
      });

      const parseTokenConfig = (
        l1Token: string,
        chainId: string,
        rawTokenConfig: TokenBalanceConfig
      ): TokenBalanceConfig => {
        const { targetPct, thresholdPct, unwrapWethThreshold, unwrapWethTarget, targetOverageBuffer } = rawTokenConfig;
        const tokenConfig: TokenBalanceConfig = { targetPct, thresholdPct, targetOverageBuffer };

        assert(
          targetPct !== undefined && thresholdPct !== undefined,
          `Bad config. Must specify targetPct, thresholdPct for ${l1Token} on ${chainId}`
        );
        assert(
          toBN(thresholdPct).lte(toBN(targetPct)),
          `Bad config. thresholdPct<=targetPct for ${l1Token} on ${chainId}`
        );
        tokenConfig.targetPct = toBNWei(targetPct).div(100);
        tokenConfig.thresholdPct = toBNWei(thresholdPct).div(100);

        // Default to 150% the targetPct. targetOverageBuffer does not have to be defined so that no existing configs
        // are broken. This is a reasonable default because it allows the relayer to be a bit more flexible in
        // holding more tokens than the targetPct, but perhaps a better default is 100%
        tokenConfig.targetOverageBuffer = toBNWei(targetOverageBuffer ?? "1.5");

        // For WETH, also consider any unwrap target/threshold.
        if (l1Token === TOKEN_SYMBOLS_MAP.WETH.symbol) {
          if (unwrapWethThreshold !== undefined) {
            tokenConfig.unwrapWethThreshold = toBNWei(unwrapWethThreshold);
          }
          tokenConfig.unwrapWethTarget = toBNWei(unwrapWethTarget ?? 2);
        }

        return tokenConfig;
      };

      const rawTokenConfigs = inventoryConfig?.tokenConfig ?? {};
      const tokenConfigs = (inventoryConfig.tokenConfig = {});
      Object.keys(rawTokenConfigs).forEach((l1Token) => {
        // If the l1Token is a symbol, resolve the correct address.
        const effectiveL1Token = ethersUtils.isAddress(l1Token)
          ? l1Token
          : TOKEN_SYMBOLS_MAP[l1Token].addresses[this.hubPoolChainId];
        assert(effectiveL1Token !== undefined, `No token identified for ${l1Token}`);

        tokenConfigs[effectiveL1Token] ??= {};
        const hubTokenConfig = rawTokenConfigs[l1Token];

        if (isAliasConfig(hubTokenConfig)) {
          Object.keys(hubTokenConfig).forEach((symbol) => {
            Object.keys(hubTokenConfig[symbol]).forEach((chainId) => {
              const rawTokenConfig = hubTokenConfig[symbol][chainId];
              const effectiveSpokeToken = TOKEN_SYMBOLS_MAP[symbol].addresses[chainId];

              tokenConfigs[effectiveL1Token][effectiveSpokeToken] ??= {};
              tokenConfigs[effectiveL1Token][effectiveSpokeToken][chainId] = parseTokenConfig(
                l1Token,
                chainId,
                rawTokenConfig
              );
            });
          });
        } else {
          Object.keys(hubTokenConfig).forEach((chainId) => {
            const rawTokenConfig = hubTokenConfig[chainId];
            tokenConfigs[effectiveL1Token][chainId] = parseTokenConfig(l1Token, chainId, rawTokenConfig);
          });
        }
      });
    }

    this.debugProfitability = DEBUG_PROFITABILITY === "true";
    this.relayerGasPadding = toBNWei(RELAYER_GAS_PADDING || Constants.DEFAULT_RELAYER_GAS_PADDING);
    this.relayerGasMultiplier = toBNWei(RELAYER_GAS_MULTIPLIER || Constants.DEFAULT_RELAYER_GAS_MULTIPLIER);
    this.relayerMessageGasMultiplier = toBNWei(
      RELAYER_GAS_MESSAGE_MULTIPLIER || Constants.DEFAULT_RELAYER_GAS_MESSAGE_MULTIPLIER
    );
    this.sendingRelaysEnabled = SEND_RELAYS === "true";
    this.sendingRebalancesEnabled = SEND_REBALANCES === "true";
    this.sendingMessageRelaysEnabled = SEND_MESSAGE_RELAYS === "true";
    this.skipRelays = SKIP_RELAYS === "true";
    this.skipRebalancing = SKIP_REBALANCING === "true";
    this.sendingSlowRelaysEnabled = SEND_SLOW_RELAYS === "true";
    this.acceptInvalidFills = ACCEPT_INVALID_FILLS === "true";

    const minDepositConfirmations = MIN_DEPOSIT_CONFIRMATIONS
      ? JSON.parse(MIN_DEPOSIT_CONFIRMATIONS)
      : Constants.MIN_DEPOSIT_CONFIRMATIONS;

    // Transform deposit confirmation requirements into an array of ascending
    // deposit confirmations, sorted by the corresponding threshold in USD.
    this.minDepositConfirmations = {};
    if (this.hubPoolChainId !== CHAIN_IDs.MAINNET) {
      // Sub in permissive defaults for testnet.
      const standardConfig = { usdThreshold: toBNWei(Number.MAX_SAFE_INTEGER), minConfirmations: 1 };
      Object.values(TESTNET_CHAIN_IDs).forEach((chainId) => (this.minDepositConfirmations[chainId] = [standardConfig]));
    } else {
      Object.keys(minDepositConfirmations)
        .map((_threshold) => {
          const threshold = Number(_threshold);
          assert(!isNaN(threshold) && threshold >= 0, `Invalid deposit confirmation threshold (${_threshold})`);
          return threshold;
        })
        .sort((x, y) => x - y)
        .forEach((usdThreshold) => {
          const config = minDepositConfirmations[usdThreshold];

          Object.entries(config).forEach(([chainId, _minConfirmations]) => {
            const minConfirmations = Number(_minConfirmations);
            assert(
              !isNaN(minConfirmations) && minConfirmations >= 0,
              `${getNetworkName(chainId)} deposit confirmations for` +
                ` ${usdThreshold} threshold missing or invalid (${_minConfirmations}).`
            );

            this.minDepositConfirmations[chainId] ??= [];
            this.minDepositConfirmations[chainId].push({ usdThreshold: toBNWei(usdThreshold), minConfirmations });
          });
        });

      // Ensure that there is always a deposit confirmation config for the maximum theoretical value of a fill.
      Object.values(this.minDepositConfirmations).forEach((depositConfirmations) => {
        const { usdThreshold: maxThreshold, minConfirmations: maxConfirmations } = depositConfirmations.at(-1);
        if (maxThreshold.lt(bnUint256Max)) {
          depositConfirmations.push({
            usdThreshold: bnUint256Max,
            minConfirmations: Math.max(maxConfirmations + 1, Number.MAX_SAFE_INTEGER),
          });
        }
      });

      // Verify that each successive USD threshold has an increasing deposit confirmation config.
      Object.values(this.minDepositConfirmations).forEach((chainMDC) => {
        chainMDC.slice(1).forEach(({ usdThreshold, minConfirmations: mdc }, idx) => {
          const usdFormatted = ethersUtils.formatEther(usdThreshold);
          const prevMDC = chainMDC[idx].minConfirmations;
          assert(
            mdc >= prevMDC,
            `Non-incrementing deposit confirmation specified for USD threshold ${usdFormatted} (${prevMDC} > ${mdc})`
          );
        });
      });
    }

    this.ignoreLimits = RELAYER_IGNORE_LIMITS === "true";
  }

  /**
   * @notice Loads additional configuration state that can only be known after we know all chains that we're going to
   * support. Warns or throws if any of the configurations are not valid.
   * @param chainIdIndices All expected chain ID's that could be supported by this config.
   * @param logger Optional logger object.
   */
  override validate(chainIds: number[], logger: winston.Logger): void {
    const { relayerOriginChains, relayerDestinationChains } = this;
    const relayerChainIds =
      relayerOriginChains.length > 0 && relayerDestinationChains.length > 0
        ? dedupArray([...relayerOriginChains, ...relayerDestinationChains])
        : chainIds;

    const ignoredChainIds = chainIds.filter(
      (chainId) => !relayerChainIds.includes(chainId) && chainId !== CHAIN_IDs.BOBA
    );
    if (ignoredChainIds.length > 0 && logger) {
      logger.debug({
        at: "RelayerConfig::validate",
        message: `Ignoring ${ignoredChainIds.length} chains.`,
        ignoredChainIds,
      });
    }

    // Only validate config for chains that the relayer cares about.
    super.validate(relayerChainIds, logger);
  }
}

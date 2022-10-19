import { BigNumber, toBNWei, assert, toBN, replaceAddressCase } from "../utils";
import { CommonConfig, ProcessEnv } from "../common";
import * as Constants from "../common/Constants";
import { InventoryConfig } from "../interfaces";

interface MinDepositConfirmationByChainId {
  [chainId: number]: number;
}
export class RelayerConfig extends CommonConfig {
  readonly inventoryConfig: InventoryConfig;
  // Whether relay profitability is considered. If false, relayers will attempt to relay all deposits.
  readonly ignoreProfitability: boolean;
  // Whether token price fetch failures will be ignored when computing relay profitability.
  // If this is false, the relayer will throw an error when fetching prices fails.
  readonly ignoreTokenPriceFailures: boolean;
  readonly sendingRelaysEnabled: boolean;
  readonly sendingSlowRelaysEnabled: boolean;
  readonly relayerTokens: string[];
  readonly relayerDestinationChains: number[];
  readonly minRelayerFeePct: BigNumber;
  readonly acceptInvalidFills: boolean;
  // Following distances in blocks to guarantee finality on each chain.
  readonly minDepositConfirmations: {
    small: MinDepositConfirmationByChainId;
    medium: MinDepositConfirmationByChainId;
    large: MinDepositConfirmationByChainId;
  };
  readonly minDepositConfirmationUsdThresholds: {
    small: BigNumber;
    large: BigNumber;
  };

  constructor(env: ProcessEnv) {
    const {
      RELAYER_DESTINATION_CHAINS,
      IGNORE_PROFITABILITY,
      IGNORE_TOKEN_PRICE_FAILURES,
      RELAYER_INVENTORY_CONFIG,
      RELAYER_TOKENS,
      SEND_RELAYS,
      SEND_SLOW_RELAYS,
      MIN_RELAYER_FEE_PCT,
      ACCEPT_INVALID_FILLS,
      MIN_DEPOSIT_CONFIRMATIONS,
      MIN_DEPOSIT_CONFIRMATIONS_LARGE_TRANSFERS,
      MIN_DEPOSIT_CONFIRMATIONS_SMALL_TRANSFERS,
      LARGE_TRANSFER_USD_THRESHOLD,
      SMALL_TRANSFER_USD_THRESHOLD,
    } = env;
    super(env);

    // Empty means all chains.
    this.relayerDestinationChains = RELAYER_DESTINATION_CHAINS ? JSON.parse(RELAYER_DESTINATION_CHAINS) : [];
    // Empty means all tokens.
    this.relayerTokens = RELAYER_TOKENS ? JSON.parse(RELAYER_TOKENS) : [];
    this.inventoryConfig = RELAYER_INVENTORY_CONFIG ? JSON.parse(RELAYER_INVENTORY_CONFIG) : {};
    this.minRelayerFeePct = toBNWei(MIN_RELAYER_FEE_PCT || Constants.RELAYER_MIN_FEE_PCT);

    if (Object.keys(this.inventoryConfig).length > 0) {
      this.inventoryConfig = replaceAddressCase(this.inventoryConfig); // Cast any non-address case addresses.
      this.inventoryConfig.wrapEtherThreshold = this.inventoryConfig.wrapEtherThreshold
        ? toBNWei(this.inventoryConfig.wrapEtherThreshold)
        : toBNWei(1); // default to keeping 2 Eth on the target chains and wrapping the rest to WETH.

      Object.keys(this.inventoryConfig.tokenConfig).forEach((l1Token) => {
        Object.keys(this.inventoryConfig.tokenConfig[l1Token]).forEach((chainId) => {
          const { targetPct, thresholdPct, unwrapWethThreshold, unwrapWethTarget } =
            this.inventoryConfig.tokenConfig[l1Token][chainId];
          assert(
            targetPct !== undefined && thresholdPct !== undefined,
            `Bad config. Must specify targetPct, thresholdPct for ${l1Token} on ${chainId}`
          );
          assert(
            toBN(thresholdPct).lte(toBN(targetPct)),
            `Bad config. thresholdPct<=targetPct for ${l1Token} on ${chainId}`
          );
          this.inventoryConfig.tokenConfig[l1Token][chainId].targetPct = toBNWei(targetPct).div(100);
          this.inventoryConfig.tokenConfig[l1Token][chainId].thresholdPct = toBNWei(thresholdPct).div(100);
          if (unwrapWethThreshold !== undefined)
            this.inventoryConfig.tokenConfig[l1Token][chainId].unwrapWethThreshold = toBNWei(unwrapWethThreshold);
          this.inventoryConfig.tokenConfig[l1Token][chainId].unwrapWethTarget = unwrapWethTarget
            ? toBNWei(unwrapWethTarget)
            : toBNWei(2);
        });
      });
    }
    this.ignoreProfitability = IGNORE_PROFITABILITY === "true";
    this.ignoreTokenPriceFailures = IGNORE_TOKEN_PRICE_FAILURES === "true";
    this.sendingRelaysEnabled = SEND_RELAYS === "true";
    this.sendingSlowRelaysEnabled = SEND_SLOW_RELAYS === "true";
    this.acceptInvalidFills = ACCEPT_INVALID_FILLS === "true";
    this.minDepositConfirmations = {
      small: MIN_DEPOSIT_CONFIRMATIONS_SMALL_TRANSFERS
        ? JSON.parse(MIN_DEPOSIT_CONFIRMATIONS_SMALL_TRANSFERS)
        : Constants.MIN_DEPOSIT_CONFIRMATIONS_SMALL_TRANSFERS,
      medium: MIN_DEPOSIT_CONFIRMATIONS ? JSON.parse(MIN_DEPOSIT_CONFIRMATIONS) : Constants.MIN_DEPOSIT_CONFIRMATIONS,
      large: MIN_DEPOSIT_CONFIRMATIONS_LARGE_TRANSFERS
        ? JSON.parse(MIN_DEPOSIT_CONFIRMATIONS_LARGE_TRANSFERS)
        : Constants.MIN_DEPOSIT_CONFIRMATIONS_LARGE_TRANSFERS,
    };
    this.minDepositConfirmationUsdThresholds = {
      small: toBNWei(SMALL_TRANSFER_USD_THRESHOLD || Constants.SMALL_TRANSFER_USD_THRESHOLD),
      large: toBNWei(LARGE_TRANSFER_USD_THRESHOLD || Constants.LARGE_TRANSFER_USD_THRESHOLD),
    };

    this.spokePoolChains.forEach((chainId) => {
      Object.keys(this.minDepositConfirmations).forEach((mdcConfigName) => {
        const nBlocks: number = this.minDepositConfirmations[mdcConfigName][chainId];
        assert(
          !isNaN(nBlocks) && nBlocks >= 0,
          `Chain ${chainId} minimum deposit confirmations for "${mdcConfigName}" config missing or invalid (${nBlocks}).`
        );
      });
    });
  }
}

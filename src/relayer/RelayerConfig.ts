import { BigNumber, toBNWei, assert, toBN, replaceAddressCase, ethers } from "../utils";
import { CommonConfig, ProcessEnv } from "../common";
import * as Constants from "../common/Constants";
import { InventoryConfig } from "../interfaces";

export class RelayerConfig extends CommonConfig {
  readonly inventoryConfig: InventoryConfig;
  // Whether relay profitability is considered. If false, relayers will attempt to relay all deposits.
  readonly ignoreProfitability: boolean;
  readonly debugProfitability: boolean;
  // Whether token price fetch failures will be ignored when computing relay profitability.
  // If this is false, the relayer will throw an error when fetching prices fails.
  readonly sendingRelaysEnabled: boolean;
  readonly sendingSlowRelaysEnabled: boolean;
  readonly sendingRefundRequestsEnabled: boolean;
  readonly relayerTokens: string[];
  readonly relayerDestinationChains: number[];
  readonly relayerGasMultiplier: BigNumber;
  readonly minRelayerFeePct: BigNumber;
  readonly acceptInvalidFills: boolean;
  // List of depositors we only want to send slow fills for.
  readonly slowDepositors: string[];
  // Following distances in blocks to guarantee finality on each chain.
  readonly minDepositConfirmations: {
    [threshold: number]: { [chainId: number]: number };
  };
  // Quote timestamp buffer to protect relayer from edge case where a quote time is > HEAD's latest block.
  // This exposes relayer to risk that HubPool utilization changes between now and the eventual block mined at that
  // timestamp, since the ConfigStoreClient.computeRealizedLpFee returns the current lpFee % for quote times >
  // HEAD
  readonly quoteTimeBuffer: number;
  // Set to false to skip querying max deposit limit from /limits Vercel API endpoint. Otherwise relayer will not
  // fill any deposit over the limit which is based on liquidReserves in the HubPool.
  readonly ignoreLimits: boolean;

  constructor(env: ProcessEnv) {
    const {
      RELAYER_DESTINATION_CHAINS,
      SLOW_DEPOSITORS,
      DEBUG_PROFITABILITY,
      RELAYER_GAS_MULTIPLIER,
      RELAYER_INVENTORY_CONFIG,
      RELAYER_TOKENS,
      SEND_RELAYS,
      SEND_SLOW_RELAYS,
      SEND_REFUND_REQUESTS,
      MIN_RELAYER_FEE_PCT,
      ACCEPT_INVALID_FILLS,
      MIN_DEPOSIT_CONFIRMATIONS,
      QUOTE_TIME_BUFFER,
      RELAYER_IGNORE_LIMITS,
    } = env;
    super(env);

    // Empty means all chains.
    this.relayerDestinationChains = RELAYER_DESTINATION_CHAINS ? JSON.parse(RELAYER_DESTINATION_CHAINS) : [];
    // Empty means all tokens.
    this.relayerTokens = RELAYER_TOKENS
      ? JSON.parse(RELAYER_TOKENS).map((token) => ethers.utils.getAddress(token))
      : [];
    this.slowDepositors = SLOW_DEPOSITORS
      ? JSON.parse(SLOW_DEPOSITORS).map((depositor) => ethers.utils.getAddress(depositor))
      : [];
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
          if (unwrapWethThreshold !== undefined) {
            this.inventoryConfig.tokenConfig[l1Token][chainId].unwrapWethThreshold = toBNWei(unwrapWethThreshold);
          }
          this.inventoryConfig.tokenConfig[l1Token][chainId].unwrapWethTarget = unwrapWethTarget
            ? toBNWei(unwrapWethTarget)
            : toBNWei(2);
        });
      });
    }
    this.debugProfitability = DEBUG_PROFITABILITY === "true";
    this.relayerGasMultiplier = toBNWei(RELAYER_GAS_MULTIPLIER || Constants.DEFAULT_RELAYER_GAS_MULTIPLIER);
    this.sendingRelaysEnabled = SEND_RELAYS === "true";
    this.sendingRefundRequestsEnabled = SEND_REFUND_REQUESTS !== "false";
    this.sendingSlowRelaysEnabled = SEND_SLOW_RELAYS === "true";
    this.acceptInvalidFills = ACCEPT_INVALID_FILLS === "true";
    (this.minDepositConfirmations = MIN_DEPOSIT_CONFIRMATIONS
      ? JSON.parse(MIN_DEPOSIT_CONFIRMATIONS)
      : Constants.MIN_DEPOSIT_CONFIRMATIONS),
      Object.keys(this.minDepositConfirmations).forEach((threshold) => {
        Object.keys(this.minDepositConfirmations[threshold]).forEach((chainId) => {
          const nBlocks: number = this.minDepositConfirmations[threshold][chainId];
          assert(
            !isNaN(nBlocks) && nBlocks >= 0,
            `Chain ${chainId} minimum deposit confirmations for "${threshold}" threshold missing or invalid (${nBlocks}).`
          );
        });
      });
    // Force default thresholds in MDC config.
    this.minDepositConfirmations["default"] = Constants.DEFAULT_MIN_DEPOSIT_CONFIRMATIONS;
    this.quoteTimeBuffer = QUOTE_TIME_BUFFER ? Number(QUOTE_TIME_BUFFER) : Constants.QUOTE_TIME_BUFFER;
    this.ignoreLimits = RELAYER_IGNORE_LIMITS === "true";
  }
}

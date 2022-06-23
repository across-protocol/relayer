import { BigNumber, toBNWei, assert, toBN, replaceAddressCase } from "../utils";
import { CommonConfig, ProcessEnv } from "../common";
import { InventoryConfig } from "../interfaces";

export class RelayerConfig extends CommonConfig {
  readonly maxRelayerLookBack: { [chainId: number]: number };
  readonly maxRelayerUnfilledDepositLookBack: { [chainId: number]: number };
  readonly inventoryConfig: InventoryConfig;
  readonly relayerDiscount: BigNumber;
  readonly sendingRelaysEnabled: Boolean;
  readonly sendingSlowRelaysEnabled: Boolean;

  constructor(env: ProcessEnv) {
    const { RELAYER_DISCOUNT, MAX_RELAYER_DEPOSIT_LOOK_BACK, RELAYER_INVENTORY_CONFIG, SEND_RELAYS, SEND_SLOW_RELAYS } =
      env;
    super(env);

    // `maxRelayerLookBack` is how far we fetch events from, modifying the search config's 'fromBlock'
    this.maxRelayerLookBack = MAX_RELAYER_DEPOSIT_LOOK_BACK ? JSON.parse(MAX_RELAYER_DEPOSIT_LOOK_BACK) : {};
    // `maxRelayerUnfilledDepositLookBack` informs relayer to ignore any unfilled deposits older than this amount of
    // of blocks from latest. This allows us to ignore any false positive unfilled deposits that occur because of how
    // `maxRelayerLookBack` is set. This can happen because block lookback per chain is not exactly equal to the same
    // amount of time looking back on the chains, so you might produce some deposits that look like they weren't filled.
    this.maxRelayerUnfilledDepositLookBack = { ...this.maxRelayerLookBack };
    Object.keys(this.maxRelayerUnfilledDepositLookBack).forEach((chain) => {
      this.maxRelayerUnfilledDepositLookBack[chain] = Number(this.maxRelayerLookBack[chain]) / 2; // TODO: Allow caller
      // to modify what we divide `maxRelayerLookBack` values by.
    });

    this.inventoryConfig = RELAYER_INVENTORY_CONFIG ? JSON.parse(RELAYER_INVENTORY_CONFIG) : {};

    if (Object.keys(this.inventoryConfig).length > 0) {
      this.inventoryConfig = replaceAddressCase(this.inventoryConfig); // Cast any non-address case addresses.
      this.inventoryConfig.wrapEtherThreshold = this.inventoryConfig.wrapEtherThreshold
        ? toBNWei(this.inventoryConfig.wrapEtherThreshold)
        : toBNWei(1); // default to keeping 2 Eth on the target chains and wrapping the rest to WETH.

      Object.keys(this.inventoryConfig.tokenConfig).forEach((l1Token) => {
        Object.keys(this.inventoryConfig.tokenConfig[l1Token]).forEach((chainId) => {
          const { targetPct, thresholdPct } = this.inventoryConfig.tokenConfig[l1Token][chainId];
          assert(
            targetPct != undefined && thresholdPct != undefined,
            `Bad config. Must specify targetPct, thresholdPct for ${l1Token} on ${chainId}`
          );
          assert(
            toBN(thresholdPct).lte(toBN(targetPct)),
            `Bad config. thresholdPct<=targetPct for ${l1Token} on ${chainId}`
          );

          this.inventoryConfig.tokenConfig[l1Token][chainId].targetPct = toBNWei(targetPct).div(100);
          this.inventoryConfig.tokenConfig[l1Token][chainId].thresholdPct = toBNWei(thresholdPct).div(100);
        });
      });
    }
    this.relayerDiscount = RELAYER_DISCOUNT ? toBNWei(RELAYER_DISCOUNT) : toBNWei(0);
    this.sendingRelaysEnabled = SEND_RELAYS === "true";
    this.sendingSlowRelaysEnabled = SEND_SLOW_RELAYS === "true";
  }
}

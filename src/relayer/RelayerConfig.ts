import { BigNumber, toBNWei, assert, toBN, replaceAddressCase } from "../utils";
import { CommonConfig, ProcessEnv } from "../common";
import { InventoryConfig } from "../interfaces";

export class RelayerConfig extends CommonConfig {
  readonly inventoryConfig: InventoryConfig;
  readonly relayerDiscount: BigNumber;
  readonly sendingRelaysEnabled: Boolean;
  readonly sendingSlowRelaysEnabled: Boolean;

  constructor(env: ProcessEnv) {
    const { RELAYER_DISCOUNT, RELAYER_INVENTORY_CONFIG, SEND_RELAYS, SEND_SLOW_RELAYS } = env;
    super(env);

    this.inventoryConfig = RELAYER_INVENTORY_CONFIG ? JSON.parse(RELAYER_INVENTORY_CONFIG) : {};

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
    this.relayerDiscount = RELAYER_DISCOUNT ? toBNWei(RELAYER_DISCOUNT) : toBNWei(0);
    this.sendingRelaysEnabled = SEND_RELAYS === "true";
    this.sendingSlowRelaysEnabled = SEND_SLOW_RELAYS === "true";
  }
}

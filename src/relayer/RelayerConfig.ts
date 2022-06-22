import { BigNumber, toBNWei, assert, toBN, replaceAddressCase } from "../utils";
import { CommonConfig, ProcessEnv } from "../common";
import { InventoryConfig } from "../interfaces";

export class RelayerConfig extends CommonConfig {
  readonly maxRelayerLookBack: { [chainId: number]: number };
  readonly inventoryConfig: InventoryConfig;
  readonly relayerDiscount: BigNumber;
  readonly sendingRelaysEnabled: Boolean;
  readonly sendingSlowRelaysEnabled: Boolean;

  constructor(env: ProcessEnv) {
    const { RELAYER_DISCOUNT, MAX_RELAYER_DEPOSIT_LOOK_BACK, RELAYER_INVENTORY_CONFIG, SEND_RELAYS, SEND_SLOW_RELAYS } =
      env;
    super(env);
    this.maxRelayerLookBack = MAX_RELAYER_DEPOSIT_LOOK_BACK ? JSON.parse(MAX_RELAYER_DEPOSIT_LOOK_BACK) : {};
    this.inventoryConfig = RELAYER_INVENTORY_CONFIG ? JSON.parse(RELAYER_INVENTORY_CONFIG) : {};

    if (Object.keys(this.inventoryConfig).length > 0) {
      this.inventoryConfig = replaceAddressCase(this.inventoryConfig); // Cast any non-address case addresses.
      this.inventoryConfig.wrapEtherThreshold = this.inventoryConfig.wrapEtherThreshold
        ? toBNWei(this.inventoryConfig.wrapEtherThreshold)
        : toBNWei(1); // default to keeping 2 Eth on the target chains and wrapping the rest to WETH.

      Object.keys(this.inventoryConfig.tokenConfig).forEach((l1Token) => {
        Object.keys(this.inventoryConfig.tokenConfig[l1Token]).forEach((chainId) => {
          const { targetPct, thresholdPct, partialFillAmountPct, partialFillThresholdPct } =
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

          // Partial fill configs are optional:
          if (partialFillThresholdPct) {
            assert(
              toBN(partialFillThresholdPct).lte(toBN(100)),
              `Bad config. partialFillThresholdPct<=100 for ${l1Token} on ${chainId}`
            );
          }
          this.inventoryConfig.tokenConfig[l1Token][chainId].partialFillThresholdPct = partialFillThresholdPct
            ? toBNWei(partialFillThresholdPct).div(100)
            : toBNWei("0"); // Defaulting this to 0% means that the relayer will never send partial fills because its
          // balance allocation will always be >= 0%. Conversely, setting this to 100% means the relayer will
          // always attempt to send partial fills.
          if (partialFillAmountPct) {
            assert(
              toBN(partialFillAmountPct).lte(toBN(100)),
              `Bad config. partialFillAmountPct<=100 for ${l1Token} on ${chainId}`
            );
          }
          this.inventoryConfig.tokenConfig[l1Token][chainId].partialFillAmountPct = partialFillAmountPct
            ? toBNWei(partialFillAmountPct).div(100)
            : toBNWei("0.25"); // By default, will use 25% of its balance to send partial fills.
        });
      });
    }
    this.relayerDiscount = RELAYER_DISCOUNT ? toBNWei(RELAYER_DISCOUNT) : toBNWei(0);
    this.sendingRelaysEnabled = SEND_RELAYS === "true";
    this.sendingSlowRelaysEnabled = SEND_SLOW_RELAYS === "true";
  }
}

import { BigNumber, toBNWei } from "../utils";
import { CommonConfig, ProcessEnv } from "../common";
import { InventorySettings } from "../interfaces";

export class RelayerConfig extends CommonConfig {
  readonly relayerDiscount: BigNumber;
  readonly inventorySettings: InventorySettings;

  constructor(env: ProcessEnv) {
    const { RELAYER_DISCOUNT, INVENTORY_SETTINGS } = env;
    super(env);
    this.relayerDiscount = RELAYER_DISCOUNT ? toBNWei(RELAYER_DISCOUNT) : toBNWei(0);

    this.inventorySettings = INVENTORY_SETTINGS ? JSON.parse(INVENTORY_SETTINGS) : {};
  }
}

import { BigNumber, toBNWei, assert } from "../utils";
import { CommonConfig, ProcessEnv } from "../common";
import { InventorySettings } from "../interfaces";

export class RelayerConfig extends CommonConfig {
  readonly relayerDiscount: BigNumber;
  readonly maxRelayerLookBack: { [chainId: number]: number };
  readonly inventorySettings: InventorySettings;

  constructor(env: ProcessEnv) {
    const { RELAYER_DISCOUNT, MAX_RELAYER_DEPOSIT_LOOK_BACK, RELAYER_INVENTORY_CONFIG } = env;
    super(env);
    this.relayerDiscount = RELAYER_DISCOUNT ? toBNWei(RELAYER_DISCOUNT) : toBNWei(0);
    this.maxRelayerLookBack = MAX_RELAYER_DEPOSIT_LOOK_BACK ? JSON.parse(MAX_RELAYER_DEPOSIT_LOOK_BACK) : {};
    this.inventorySettings = RELAYER_INVENTORY_CONFIG ? JSON.parse(RELAYER_INVENTORY_CONFIG) : {};
    const sumAllocation = Object.values(this.inventorySettings.targetL2PctOfTotal).reduce((acc, curr) => acc + curr, 0);
    assert(sumAllocation == 100, `Relayer inventory targetL2PctOfTotal must sum to 100. Summed to ${sumAllocation}`);
  }
}

import { BigNumber, toBNWei, assert } from "../utils";
import { CommonConfig, ProcessEnv } from "../common";
import { InventoryConfig } from "../interfaces";

export class RelayerConfig extends CommonConfig {
  readonly maxRelayerLookBack: { [chainId: number]: number };
  readonly inventoryConfig: InventoryConfig;
  readonly relayerDiscount: BigNumber;

  constructor(env: ProcessEnv) {
    const { RELAYER_DISCOUNT, MAX_RELAYER_DEPOSIT_LOOK_BACK, RELAYER_INVENTORY_CONFIG } = env;
    super(env);
    this.maxRelayerLookBack = MAX_RELAYER_DEPOSIT_LOOK_BACK ? JSON.parse(MAX_RELAYER_DEPOSIT_LOOK_BACK) : {};
    this.inventoryConfig = RELAYER_INVENTORY_CONFIG ? JSON.parse(RELAYER_INVENTORY_CONFIG) : {};
    const sumAllocation = Object.values(this.inventoryConfig.targetL2PctOfTotal).reduce((acc, curr) => acc + curr, 0);
    assert(sumAllocation == 100, `Relayer inventory targetL2PctOfTotal must sum to 100. Summed to ${sumAllocation}`);

    this.relayerDiscount = RELAYER_DISCOUNT ? toBNWei(RELAYER_DISCOUNT) : toBNWei(0);
  }
}

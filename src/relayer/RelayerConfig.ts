import { BigNumber, toWei, assert, utils } from "../utils";
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

    if (this.inventoryConfig) {
      const sumAllocation = Object.values(this.inventoryConfig.targetL2PctOfTotal)
        .map((num) => Number(num))
        .reduce((acc: number, curr: number) => acc + curr, 0);
      assert(sumAllocation == 100, `Relayer inventory targetL2PctOfTotal must sum to 100. Summed to ${sumAllocation}`);
      Object.keys(this.inventoryConfig.targetL2PctOfTotal).forEach(
        (id) =>
          (this.inventoryConfig.targetL2PctOfTotal[id] = toWei(this.inventoryConfig.targetL2PctOfTotal[id]).div(100))
      );
      this.inventoryConfig.wrapEtherThreshold = this.inventoryConfig.wrapEtherThreshold
        ? toWei(this.inventoryConfig.wrapEtherThreshold)
        : toWei(2); // default to keeping 2 Eth on the target chains and wrapping the rest to WETH.

      this.inventoryConfig.rebalanceOvershoot = this.inventoryConfig.rebalanceOvershoot
        ? toWei(this.inventoryConfig.rebalanceOvershoot).div(100)
        : toWei(0.05); // default to keeping overshooting by 5%.

      this.inventoryConfig.managedL1Tokens = this.inventoryConfig.managedL1Tokens.map((l1Token) =>
        utils.getAddress(l1Token)
      );
    }

    this.relayerDiscount = RELAYER_DISCOUNT ? toWei(RELAYER_DISCOUNT) : toWei(0);
  }
}

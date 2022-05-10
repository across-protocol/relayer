import { BigNumber, winston, toBNWei, toBN, assign } from "../../utils";

import { InventorySettings } from "../../interfaces";

export class InventoryManagementClient {
  constructor(readonly logger: winston.Logger, inventorySettings: InventorySettings) {}
}

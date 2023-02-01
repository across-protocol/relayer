import { Deposit } from "../../src/interfaces";
import { InventoryClient } from "../../src/clients";
export class MockInventoryClient extends InventoryClient {
  constructor() {
    super(null, null, null, null, null, null, null, null, null);
  }
  async determineRefundChainId(_deposit: Deposit) {
    return 1;
  }
}

import { Deposit } from "../../src/interfaces";
import { InventoryClient } from "../../src/clients";
export class MockInventoryClient extends InventoryClient {
  constructor() {
    super(null, null, null, null, null, null, null, null);
  }
  determineRefundChainId(deposit: Deposit) {
    return 1;
  }
}

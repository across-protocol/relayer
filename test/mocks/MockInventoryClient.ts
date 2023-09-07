import { Deposit } from "../../src/interfaces";
import { InventoryClient } from "../../src/clients";
export class MockInventoryClient extends InventoryClient {
  constructor() {
    super(null, null, null, null, null, null, null, null, null);
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  determineRefundChainId(_deposit: Deposit): Promise<number> {
    return Promise.resolve(1);
  }
}

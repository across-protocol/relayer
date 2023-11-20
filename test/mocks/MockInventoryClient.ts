import { Deposit } from "../../src/interfaces";
import { InventoryClient, Rebalance } from "../../src/clients";
export class MockInventoryClient extends InventoryClient {
  possibleRebalances: Rebalance[] = [];
  constructor() {
    super(null, null, null, null, null, null, null, null, null);
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async determineRefundChainId(_deposit: Deposit): Promise<number> {
    return 1;
  }

  addPossibleRebalance(rebalance: Rebalance): void {
    this.possibleRebalances.push(rebalance);
  }

  clearPossibleRebalances(): void {
    this.possibleRebalances = [];
  }

  getPossibleRebalances(): Rebalance[] {
    return this.possibleRebalances;
  }
}

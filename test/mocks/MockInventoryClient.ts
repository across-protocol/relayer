import { Deposit } from "../../src/interfaces";
import { InventoryClient, Rebalance } from "../../src/clients";
import { CrossChainTransferClient } from "../../src/clients/bridges";
export class MockInventoryClient extends InventoryClient {
  possibleRebalances: Rebalance[] = [];
  constructor(crossChainTransferClient: CrossChainTransferClient | null = null) {
    super(
      null, // relayer
      null, // logger
      null, // inventory config
      null, // token client
      null, // chain ID list
      null, // hubPoolClient
      null, // bundleDataClient
      null, // adapter manager
      crossChainTransferClient
    );
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

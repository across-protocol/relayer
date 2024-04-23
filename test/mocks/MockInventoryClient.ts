import { Deposit, InventoryConfig } from "../../src/interfaces";
import { BundleDataClient, HubPoolClient, InventoryClient, Rebalance, TokenClient } from "../../src/clients";
import { AdapterManager, CrossChainTransferClient } from "../../src/clients/bridges";
import { BigNumber } from "ethers";
import winston from "winston";
export class MockInventoryClient extends InventoryClient {
  possibleRebalances: Rebalance[] = [];
  balanceOnChain: BigNumber = BigNumber.from(0);
  excessRunningBalancePcts: { [l1Token: string]: { [chainId: number]: BigNumber } } = {};

  constructor(
    relayer: string | null = null,
    logger: winston.Logger | null = null,
    inventoryConfig: InventoryConfig | null = null,
    tokenClient: TokenClient | null = null,
    chainIds: number[] | null = null,
    hubPoolClient: HubPoolClient | null = null,
    bundleDataClient: BundleDataClient | null = null,
    adapterManager: AdapterManager | null = null,
    crossChainTransferClient: CrossChainTransferClient | null = null
  ) {
    super(
      relayer, // relayer
      logger, // logger
      inventoryConfig, // inventory config
      tokenClient, // token client
      chainIds, // chain ID list
      hubPoolClient, // hubPoolClient
      bundleDataClient, // bundleDataClient
      adapterManager, // adapter manager
      crossChainTransferClient
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async determineRefundChainId(_deposit: Deposit): Promise<number[]> {
    return this.inventoryConfig === null ? [1] : super.determineRefundChainId(_deposit);
  }

  setExcessRunningBalances(l1Token: string, balances: { [chainId: number]: BigNumber }): void {
    this.excessRunningBalancePcts[l1Token] = balances;
  }

  async getExcessRunningBalancePcts(l1Token: string): Promise<{ [chainId: number]: BigNumber }> {
    return Promise.resolve(this.excessRunningBalancePcts[l1Token]);
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

  setBalanceOnChainForL1Token(newBalance: BigNumber): void {
    this.balanceOnChain = newBalance;
  }

  getBalanceOnChainForL1Token(): BigNumber {
    return this.balanceOnChain;
  }
}

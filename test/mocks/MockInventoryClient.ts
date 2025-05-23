import { Deposit, InventoryConfig } from "../../src/interfaces";
import { BundleDataClient, HubPoolClient, InventoryClient, Rebalance, TokenClient } from "../../src/clients";
import { AdapterManager, CrossChainTransferClient } from "../../src/clients/bridges";
import { BigNumber } from "../../src/utils";
import winston from "winston";

type TokenMapping = { [l1Token: string]: { [chainId: number]: string } };
export class MockInventoryClient extends InventoryClient {
  possibleRebalances: Rebalance[] = [];
  balanceOnChain: BigNumber | undefined = undefined;
  excessRunningBalancePcts: { [l1Token: string]: { [chainId: number]: BigNumber } } = {};
  l1Token: string | undefined = undefined;
  tokenMappings: TokenMapping | undefined = undefined;

  constructor(
    relayer: string | null = null,
    logger: winston.Logger | null = null,
    inventoryConfig: InventoryConfig | null = null,
    tokenClient: TokenClient | null = null,
    chainIds: number[] | null = null,
    hubPoolClient: HubPoolClient | null = null,
    bundleDataClient: BundleDataClient | null = null,
    adapterManager: AdapterManager | null = null,
    crossChainTransferClient: CrossChainTransferClient | null = null,
    simMode = false,
    prioritizeLpUtilization = false
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
      crossChainTransferClient,
      simMode, // sim mode
      prioritizeLpUtilization // prioritize lp utilization
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override async determineRefundChainId(_deposit: Deposit): Promise<number[]> {
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

  override getPossibleRebalances(): Rebalance[] {
    return this.possibleRebalances;
  }

  setBalanceOnChainForL1Token(newBalance: BigNumber | undefined): void {
    this.balanceOnChain = newBalance;
  }

  override getBalanceOnChain(chainId: number, l1Token: string, l2Token?: string): BigNumber {
    return this.balanceOnChain ?? super.getBalanceOnChain(chainId, l1Token, l2Token);
  }

  setTokenMapping(tokenMapping: TokenMapping): void {
    this.tokenMappings = tokenMapping;
  }

  canTakeDestinationChainRepayment(
    deposit: Pick<Deposit, "inputToken" | "originChainId" | "outputToken" | "destinationChainId" | "fromLiteChain">
  ): boolean {
    if (deposit.fromLiteChain) {
      return false;
    }
    if (this.tokenMappings) {
      const hasOriginChainMapping = Object.values(this.tokenMappings).some(
        (mapping) => mapping[deposit.originChainId] === deposit.inputToken
      );
      const hasDestinationChainMapping = Object.values(this.tokenMappings).some(
        (mapping) => mapping[deposit.destinationChainId] === deposit.outputToken
      );
      return hasOriginChainMapping && hasDestinationChainMapping;
    }
    return super.canTakeDestinationChainRepayment(deposit);
  }

  override getRemoteTokenForL1Token(l1Token: string, chainId: number | string): string | undefined {
    if (this.tokenMappings) {
      const tokenMapping = Object.values(this.tokenMappings).find((mapping) => mapping[l1Token]);
      if (tokenMapping) {
        return tokenMapping[l1Token][chainId];
      }
    }
    return super.getRemoteTokenForL1Token(l1Token, chainId);
  }

  override getL1TokenAddress(l2Token: string, chainId: number): string {
    if (this.tokenMappings) {
      const tokenMapping = Object.entries(this.tokenMappings).find(([, mapping]) => mapping[chainId] === l2Token);
      if (tokenMapping) {
        return tokenMapping[0];
      }
    }
    return super.getL1TokenAddress(l2Token, chainId);
  }
}

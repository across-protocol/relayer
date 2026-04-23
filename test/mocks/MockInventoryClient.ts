import { Deposit, InventoryConfig, TokenInfo } from "../../src/interfaces";
import { BinanceClient, HubPoolClient, InventoryClient, Rebalance, TokenClient } from "../../src/clients";
import { AdapterManager, CrossChainTransferClient } from "../../src/clients/bridges";
import { Address, BigNumber, bnZero, EvmAddress, getTokenInfo, toAddressType } from "../../src/utils";
import winston from "winston";
import { RebalancerClient } from "../../src/rebalancer/utils/interfaces";

type TokenMapping = { [l1Token: string]: { [chainId: number]: string } };
export class MockInventoryClient extends InventoryClient {
  possibleRebalances: Rebalance[] = [];
  balanceOnChain: BigNumber | undefined = undefined;
  excessRunningBalancePcts: { [l1Token: string]: { [chainId: number]: BigNumber } } = {};
  l1Token: string | undefined = undefined;
  tokenMappings: TokenMapping | undefined = undefined;
  upcomingRefunds: { [l1Token: string]: { [chainId: number]: BigNumber } } = {};

  constructor(
    relayer: string | null = null,
    logger: winston.Logger | null = null,
    inventoryConfig: InventoryConfig | null = null,
    tokenClient: TokenClient | null = null,
    chainIds: number[] | null = null,
    hubPoolClient: HubPoolClient | null = null,
    adapterManager: AdapterManager | null = null,
    crossChainTransferClient: CrossChainTransferClient | null = null,
    rebalancerClient: RebalancerClient | null = null,
    simMode = false,
    prioritizeLpUtilization = false
  ) {
    const effectiveLogger = logger ?? winston.createLogger({ silent: true });
    super(
      relayer, // relayer
      effectiveLogger, // logger
      inventoryConfig, // inventory config
      tokenClient, // token client
      chainIds, // chain ID list
      hubPoolClient, // hubPoolClient
      adapterManager, // adapter manager
      crossChainTransferClient,
      rebalancerClient, // rebalancer client
      simMode, // sim mode
      prioritizeLpUtilization // prioritize lp utilization
    );
  }

  protected override getTokenInfo(token: Address, chainId: number): TokenInfo {
    try {
      return this.hubPoolClient.getTokenInfoForAddress(token, chainId);
    } catch {
      return getTokenInfo(token, chainId);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override async determineRefundChainId(_deposit: Deposit): Promise<number[]> {
    return this.inventoryConfig === null ? [1] : super.determineRefundChainId(_deposit);
  }

  setExcessRunningBalances(l1Token: string, balances: { [chainId: number]: BigNumber }): void {
    this.excessRunningBalancePcts[l1Token] = balances;
  }

  setBinanceClient(binanceClient: BinanceClient | undefined): void {
    this.binanceClient = binanceClient;
  }

  seedL1TokenPriceUsd(l1Token: string, priceUsd: BigNumber): void {
    this.l1TokenPricesUsd.set(l1Token, priceUsd);
  }

  async getExcessRunningBalancePcts(l1Token: Address): Promise<{ [chainId: number]: BigNumber }> {
    return Promise.resolve(this.excessRunningBalancePcts[l1Token.toEvmAddress()] ?? {});
  }

  override getUpcomingRefunds(chainId: number, l1Token: EvmAddress): BigNumber {
    return this.upcomingRefunds?.[l1Token.toNative()]?.[chainId] ?? bnZero;
  }

  setUpcomingRefunds(l1Token: string, refunds: { [chainId: number]: BigNumber }): void {
    this.upcomingRefunds[l1Token] = refunds;
  }

  addPossibleRebalance(rebalance: Rebalance): void {
    this.possibleRebalances.push(rebalance);
  }

  clearPossibleRebalances(): void {
    this.possibleRebalances = [];
  }

  override getPossibleRebalances(): Rebalance[] {
    return this.possibleRebalances.length > 0 ? this.possibleRebalances : super.getPossibleRebalances();
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
        (mapping) => mapping[deposit.originChainId] === deposit.inputToken.toEvmAddress()
      );
      const hasDestinationChainMapping = Object.values(this.tokenMappings).some(
        (mapping) => mapping[deposit.destinationChainId] === deposit.outputToken.toEvmAddress()
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

  override getL1TokenAddress(l2Token: Address, chainId: number): EvmAddress {
    if (this.tokenMappings) {
      const tokenMapping = Object.entries(this.tokenMappings).find(
        ([, mapping]) => mapping[chainId] === l2Token.toEvmAddress()
      );
      if (tokenMapping) {
        return toAddressType(tokenMapping[0], chainId);
      }
    }
    return super.getL1TokenAddress(l2Token, chainId);
  }
}

import {
  Address,
  assert,
  BigNumber,
  bnZero,
  EvmAddress,
  EventSearchConfig,
  getTokenInfo,
  isDefined,
  Signer,
  toBNWei,
  TransactionResponse,
  winston,
  ZERO_BYTES,
} from "../../utils";
import type { BinanceStablecoinSwapAdapter as RebalancerBinanceStablecoinSwapAdapter } from "../../rebalancer/adapters/binance";
import type { RebalanceRoute } from "../../rebalancer/utils/interfaces";
import { BaseBridgeAdapter, BridgeEvents, BridgeTransactionDetails } from "./BaseBridgeAdapter";

export class BinanceStablecoinSwapAdapter extends BaseBridgeAdapter {
  private adapter?: RebalancerBinanceStablecoinSwapAdapter;
  private route?: RebalanceRoute;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    _l2SignerOrProvider: unknown,
    private readonly l1Token: EvmAddress,
    _logger: winston.Logger,
    private readonly adapterFactory?: (route: RebalanceRoute) => Promise<RebalancerBinanceStablecoinSwapAdapter>
  ) {
    super(l2chainId, hubChainId, l1Signer, []);
  }

  async prepareL1ToL2Transfer(
    toAddress: Address,
    l1Token: EvmAddress,
    l2Token: Address,
    amount: BigNumber
  ): Promise<BigNumber> {
    const adapter = await this.getAdapter(l1Token, l2Token);
    const route = this.getRoute();
    this.assertRecipient(toAddress, adapter.baseSignerAddress);
    const maxAmount = adapter.config.maxAmountsToTransfer[route.sourceToken]?.[this.hubChainId];
    const cappedAmount = isDefined(maxAmount) && amount.gt(maxAmount) ? maxAmount : amount;
    const maxPendingOrders = adapter.config.maxPendingOrders.binance ?? 2;
    if ((await adapter.getPendingOrders()).length >= maxPendingOrders) {
      return bnZero;
    }
    const maxFee = cappedAmount.mul(toBNWei(process.env.MAX_FEE_PCT ?? "2.5")).div(toBNWei(100));
    return (await adapter.getEstimatedCost(route, cappedAmount, false)).lte(maxFee) ? cappedAmount : bnZero;
  }

  async sendL1ToL2Transfer(
    toAddress: Address,
    l1Token: EvmAddress,
    l2Token: Address,
    amount: BigNumber,
    simMode: boolean
  ): Promise<TransactionResponse> {
    const preparedAmount = await this.prepareL1ToL2Transfer(toAddress, l1Token, l2Token, amount);
    assert(preparedAmount.gt(bnZero), "Binance stablecoin swap adapter declined transfer");
    if (simMode) {
      return { hash: ZERO_BYTES } as TransactionResponse;
    }
    assert(isDefined(this.adapter));
    const result = await this.adapter.initializeRebalanceWithTransaction(this.getRoute(), preparedAmount);
    assert(result.amount.gt(bnZero), "Binance stablecoin swap adapter declined transfer during initialization");
    assert(isDefined(result.transactionHash), "Binance stablecoin swap adapter did not submit a direct deposit");
    return { hash: result.transactionHash } as TransactionResponse;
  }

  constructL1ToL2Txn(): Promise<BridgeTransactionDetails> {
    throw new Error("BinanceStablecoinSwapAdapter submits through sendL1ToL2Transfer");
  }

  queryL1BridgeInitiationEvents(): Promise<BridgeEvents> {
    // Binance lifecycle balances are already included by RebalancerClient.getPendingRebalances.
    return Promise.resolve({});
  }

  queryL2BridgeFinalizationEvents(
    _l1Token: EvmAddress,
    _fromAddress: Address,
    _toAddress: Address,
    _eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // Binance orders do not expose chain-event-shaped finalizations and must not be counted a second time here.
    return Promise.resolve({});
  }

  private async getAdapter(l1Token: EvmAddress, l2Token: Address): Promise<RebalancerBinanceStablecoinSwapAdapter> {
    assert(l1Token.eq(this.l1Token), `Unexpected L1 token ${l1Token}`);
    const route: RebalanceRoute = {
      sourceChain: this.hubChainId,
      sourceToken: getTokenInfo(l1Token, this.hubChainId).symbol,
      destinationChain: this.l2chainId,
      destinationToken: getTokenInfo(l2Token, this.l2chainId).symbol,
      adapter: "binance",
    };
    if (isDefined(this.adapter)) {
      assert(this.adapter.supportsRoute(route), "Binance stablecoin swap adapter route changed after initialization");
      return this.adapter;
    }
    assert(isDefined(this.adapterFactory), "Binance stablecoin swap adapter factory is required");
    const adapter = await this.adapterFactory(route);
    this.route = route;
    return (this.adapter = adapter);
  }

  private assertRecipient(toAddress: Address, signerAddress: EvmAddress): void {
    assert(signerAddress.eq(EvmAddress.from(toAddress.toNative())), "Binance withdrawal recipient must match signer");
  }

  private getRoute(): RebalanceRoute {
    assert(isDefined(this.route));
    return this.route;
  }
}

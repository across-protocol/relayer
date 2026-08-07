import {
  Address,
  assert,
  BigNumber,
  bnZero,
  EvmAddress,
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
import {
  BaseBridgeAdapter,
  BridgeEvents,
  BridgeTransactionDetails,
  BridgeTransferDeclinedError,
} from "./BaseBridgeAdapter";

/**
 * AdapterManager-facing bridge that initiates same-asset L1 -> L2 transfers through the rebalancer's Binance
 * adapter: deposit into Binance on L1, withdraw on the destination chain. Order progression (swap leg, withdrawal,
 * finalization) stays owned by the swap rebalancer's normal Redis order lifecycle.
 */
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
    // Optional only so the class fits the registry's L1BridgeConstructor shape; getAdapter asserts it was supplied.
    private readonly adapterFactory?: (route: RebalanceRoute) => Promise<RebalancerBinanceStablecoinSwapAdapter>
  ) {
    super(l2chainId, hubChainId, l1Signer, []);
  }

  async sendL1ToL2Transfer(
    toAddress: Address,
    l1Token: EvmAddress,
    l2Token: Address,
    amount: BigNumber,
    simMode: boolean
  ): Promise<TransactionResponse> {
    const adapter = await this.getAdapter(l1Token, l2Token);
    const route = this.getRoute();
    // Binance withdrawals land on the exchange account's withdrawal address, so the only supported recipient is
    // the signer itself.
    assert(
      adapter.baseSignerAddress.eq(EvmAddress.from(toAddress.toNative())),
      "Binance withdrawal recipient must match signer"
    );
    const maxPendingOrders = adapter.config.maxPendingOrders.binance ?? 2;
    if ((await adapter.getPendingOrders()).length >= maxPendingOrders) {
      throw new BridgeTransferDeclinedError("Too many pending Binance orders to initiate a new transfer");
    }
    const maxFee = amount.mul(toBNWei(process.env.MAX_FEE_PCT ?? "2.5")).div(toBNWei(100));
    if ((await adapter.getEstimatedCost(route, amount, false)).gt(maxFee)) {
      throw new BridgeTransferDeclinedError("Estimated Binance transfer cost exceeds the maximum fee");
    }
    if (simMode) {
      return { hash: ZERO_BYTES } as TransactionResponse;
    }
    const { amount: initializedAmount, transactionHash } = await adapter.initializeRebalanceWithTransaction(
      route,
      amount
    );
    if (initializedAmount.eq(bnZero)) {
      throw new BridgeTransferDeclinedError("Binance stablecoin swap adapter declined transfer during initialization");
    }
    assert(isDefined(transactionHash), "Binance stablecoin swap adapter did not submit a direct deposit");
    return { hash: transactionHash } as TransactionResponse;
  }

  constructL1ToL2Txn(): Promise<BridgeTransactionDetails> {
    throw new Error("BinanceStablecoinSwapAdapter submits through sendL1ToL2Transfer");
  }

  /**
   * Binance swap deposits are tracked as Redis orders, not bridge events. InventoryClient consumes them through
   * RebalancerClient.getPendingRebalances, so returning initiation events here would count the same transfer twice.
   */
  queryL1BridgeInitiationEvents(): Promise<BridgeEvents> {
    return Promise.resolve({});
  }

  /**
   * Binance withdrawals likewise have no bridge-event accounting owner: the Redis order remains a pending virtual
   * balance until the swap rebalancer finalizes it. Returning finalizations here would conflict with that lifecycle.
   */
  queryL2BridgeFinalizationEvents(): Promise<BridgeEvents> {
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

  private getRoute(): RebalanceRoute {
    assert(isDefined(this.route));
    return this.route;
  }
}

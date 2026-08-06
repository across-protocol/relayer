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
import { DefinitiveTransactionFailure } from "../../clients";
import {
  BaseBridgeAdapter,
  BridgeEvents,
  BridgeTransactionDetails,
  BridgeTransferDeclinedError,
} from "./BaseBridgeAdapter";

export class BinanceStablecoinSwapAdapter extends BaseBridgeAdapter {
  private adapter?: RebalancerBinanceStablecoinSwapAdapter;
  private route?: RebalanceRoute;
  private readonly preparedTransfers: { amount: string; reservation: string }[] = [];

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    _l2SignerOrProvider: unknown,
    private readonly l1Token: EvmAddress,
    private readonly logger: winston.Logger,
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
    const maxFee = cappedAmount.mul(toBNWei(process.env.MAX_FEE_PCT ?? "2.5")).div(toBNWei(100));
    if ((await adapter.getEstimatedCost(route, cappedAmount, false)).gt(maxFee)) {
      return bnZero;
    }
    const preparedAmount = await adapter.getValidatedRebalanceAmount(route, cappedAmount);
    if (preparedAmount.gt(bnZero)) {
      const candidate = JSON.stringify([
        route.sourceChain,
        route.sourceToken,
        route.destinationChain,
        route.destinationToken,
        preparedAmount.toString(),
      ]);
      const reservation = await adapter.reservePendingOrderSlot(maxPendingOrders, candidate);
      if (!isDefined(reservation)) {
        return bnZero;
      }
      this.preparedTransfers.push({ amount: preparedAmount.toString(), reservation });
    }
    return preparedAmount;
  }

  async sendL1ToL2Transfer(
    toAddress: Address,
    l1Token: EvmAddress,
    l2Token: Address,
    amount: BigNumber,
    simMode: boolean
  ): Promise<TransactionResponse> {
    const adapter = await this.getAdapter(l1Token, l2Token);
    this.assertRecipient(toAddress, adapter.baseSignerAddress);
    let preparedAmount = amount;
    let reservation = this.consumePreparedTransfer(preparedAmount);
    if (!isDefined(reservation)) {
      preparedAmount = await this.prepareL1ToL2Transfer(toAddress, l1Token, l2Token, amount);
      reservation = this.consumePreparedTransfer(preparedAmount);
    }
    assert(preparedAmount.gt(bnZero), "Binance stablecoin swap adapter declined transfer");
    assert(isDefined(reservation), "Binance stablecoin swap adapter did not reserve an order slot");
    if (simMode) {
      await this.releaseReservation(adapter, reservation);
      return { hash: ZERO_BYTES } as TransactionResponse;
    }
    let submissionStarted = false;
    const result = await adapter
      .initializeRebalanceWithTransaction(this.getRoute(), preparedAmount, () => {
        submissionStarted = true;
      })
      .catch(async (error) => {
        if (!submissionStarted || error instanceof DefinitiveTransactionFailure) {
          await this.releaseReservation(adapter, reservation);
          throw new BridgeTransferDeclinedError("Binance stablecoin swap failed before submission", { cause: error });
        }
        await this.releaseReservation(adapter, reservation);
        throw error;
      });
    await this.releaseReservation(adapter, reservation);
    if (result.amount.eq(bnZero)) {
      throw new BridgeTransferDeclinedError("Binance stablecoin swap adapter declined transfer during initialization");
    }
    assert(isDefined(result.transactionHash), "Binance stablecoin swap adapter did not submit a direct deposit");
    return { hash: result.transactionHash } as TransactionResponse;
  }

  constructL1ToL2Txn(): Promise<BridgeTransactionDetails> {
    throw new Error("BinanceStablecoinSwapAdapter submits through sendL1ToL2Transfer");
  }

  async releaseL1ToL2Transfer(amount: BigNumber): Promise<void> {
    const reservation = this.consumePreparedTransfer(amount);
    if (isDefined(reservation)) {
      assert(isDefined(this.adapter));
      await this.releaseReservation(this.adapter, reservation);
    }
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
  queryL2BridgeFinalizationEvents(
    _l1Token: EvmAddress,
    _fromAddress: Address,
    _toAddress: Address,
    _eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
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

  private consumePreparedTransfer(amount: BigNumber): string | undefined {
    const index = this.preparedTransfers.findIndex((transfer) => transfer.amount === amount.toString());
    if (index === -1) {
      return;
    }
    return this.preparedTransfers.splice(index, 1)[0].reservation;
  }

  private async releaseReservation(
    adapter: RebalancerBinanceStablecoinSwapAdapter,
    reservation: string
  ): Promise<void> {
    try {
      await adapter.releasePendingOrderSlot(reservation);
    } catch (error) {
      this.logger.warn({
        at: "BinanceStablecoinSwapAdapter.releaseReservation",
        message: "Failed to release Binance pending-order reservation; waiting for its TTL",
        error,
      });
    }
  }
}

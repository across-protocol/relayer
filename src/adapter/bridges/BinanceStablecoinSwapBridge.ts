import {
  Address,
  assert,
  BigNumber,
  bnZero,
  EvmAddress,
  getTokenInfo,
  isDefined,
  Signer,
  TransactionResponse,
  winston,
  ZERO_BYTES,
} from "../../utils";
import type { BinanceStablecoinSwapAdapter as RebalancerBinanceStablecoinSwapAdapter } from "../../rebalancer/adapters/binance";
import type { RebalanceRoute } from "../../rebalancer/utils/interfaces";
import { getMaxFee, getMaxPendingOrders } from "../../rebalancer/utils/utils";
import { BaseBridgeAdapter, BridgeEvents, BridgeTransactionDetails } from "./BaseBridgeAdapter";

/**
 * AdapterManager-facing bridge that initiates same-asset L1 -> L2 transfers through the rebalancer's Binance
 * adapter: deposit into Binance on L1, withdraw on the destination chain. Order progression (swap leg, withdrawal,
 * finalization) stays owned by the swap rebalancer's normal Redis order lifecycle.
 */
export class BinanceStablecoinSwapBridge extends BaseBridgeAdapter {
  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    _l2SignerOrProvider: unknown,
    private readonly l1Token: EvmAddress,
    _logger: winston.Logger,
    private readonly adapterPromise?: Promise<RebalancerBinanceStablecoinSwapAdapter>
  ) {
    super(l2chainId, hubChainId, l1Signer, []);
  }

  /**
   * One-shot initiation: the returned promise either resolves with the Binance deposit transaction hash or
   * rejects with no funds moved and no Redis state created. We deliberately treat every Binance-side failure —
   * capacity, fee cap, withdrawal suspension, API outage, adapter preflight — exactly like a contract bridge
   * whose submitted transaction failed to mine: the caller's generic failed-send handling applies, its balance
   * accounting stays conservative for the remainder of the run, and the next inventory update self-corrects.
   * No decline/rollback classification exists on purpose; the bridge behaves like an atomic contract call.
   */
  async sendL1ToL2Transfer(
    toAddress: Address,
    l1Token: EvmAddress,
    l2Token: Address,
    amount: BigNumber,
    simMode: boolean
  ): Promise<TransactionResponse> {
    const [adapter, route] = await this.getAdapterAndRoute(l1Token, l2Token);
    // Binance withdrawals land on the exchange account's withdrawal address, so the only supported recipient is
    // the signer itself.
    assert(adapter.baseSignerAddress.eq(toAddress), "Binance withdrawal recipient must match signer");
    // Fail fast rather than resize: AdapterManager callers assume a transfer either sends the requested amount
    // or rejects, so a candidate above the configured Binance maximum is rejected outright.
    const maxAmount = adapter.config.maxAmountsToTransfer[route.sourceToken]?.[route.sourceChain];
    assert(
      !isDefined(maxAmount) || amount.lte(maxAmount),
      "Transfer amount exceeds the configured Binance maximum transfer amount"
    );
    const [pendingOrders, estimatedCost] = await Promise.all([
      adapter.getPendingOrders(),
      adapter.getEstimatedCost(route, amount, false),
    ]);
    assert(
      pendingOrders.length < getMaxPendingOrders(adapter.config, "binance"),
      "Too many pending Binance orders to initiate a new transfer"
    );
    assert(estimatedCost.lte(getMaxFee(amount)), "Estimated Binance transfer cost exceeds the maximum fee");
    if (simMode) {
      return { hash: ZERO_BYTES } as TransactionResponse;
    }
    // Direct deposits only: an intermediate-bridge initiation would move funds without a returnable deposit
    // transaction, so the adapter declines it before committing anything.
    const { amount: initializedAmount, transactionHash } = await adapter.initializeRebalanceWithTransaction(
      route,
      amount,
      { directDepositOnly: true }
    );
    assert(!initializedAmount.eq(bnZero), "Binance stablecoin swap adapter declined transfer during initialization");
    assert(isDefined(transactionHash), "Binance stablecoin swap adapter did not submit a direct deposit");
    return { hash: transactionHash } as TransactionResponse;
  }

  constructL1ToL2Txn(): Promise<BridgeTransactionDetails> {
    throw new Error("BinanceStablecoinSwapBridge submits through sendL1ToL2Transfer");
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

  private async getAdapterAndRoute(
    l1Token: EvmAddress,
    l2Token: Address
  ): Promise<[RebalancerBinanceStablecoinSwapAdapter, RebalanceRoute]> {
    assert(l1Token.eq(this.l1Token), `Unexpected L1 token ${l1Token}`);
    const route: RebalanceRoute = {
      sourceChain: this.hubChainId,
      sourceToken: getTokenInfo(l1Token, this.hubChainId).symbol,
      destinationChain: this.l2chainId,
      destinationToken: getTokenInfo(l2Token, this.l2chainId).symbol,
      adapter: "binance",
    };
    assert(isDefined(this.adapterPromise), "Binance stablecoin swap rebalancer adapter is unavailable");
    const adapter = await this.adapterPromise;
    assert(adapter.supportsRoute(route), "Binance stablecoin swap adapter does not support this route");
    return [adapter, route];
  }
}

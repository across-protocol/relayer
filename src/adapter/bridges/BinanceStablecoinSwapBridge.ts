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
export class BinanceStablecoinSwapBridge extends BaseBridgeAdapter {
  private adapter?: Promise<RebalancerBinanceStablecoinSwapAdapter>;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    _l2SignerOrProvider: unknown,
    private readonly l1Token: EvmAddress,
    private readonly logger: winston.Logger,
    // Optional only so the class fits the registry's L1BridgeConstructor shape; getAdapterAndRoute asserts it
    // was supplied.
    private readonly adapterFactory?: (route: RebalanceRoute) => Promise<RebalancerBinanceStablecoinSwapAdapter>
  ) {
    super(l2chainId, hubChainId, l1Signer, []);
  }

  // Cap the transfer at the rebalancer config's per-token, per-source-chain maximum, mirroring the same-asset
  // rebalancer's sizing. InventoryClient calls this before tracking any balances.
  async getAcceptedL1ToL2TransferAmount(l1Token: EvmAddress, l2Token: Address, amount: BigNumber): Promise<BigNumber> {
    const [adapter, route] = await this.getAdapterAndRoute(l1Token, l2Token);
    const maxAmount = adapter.config.maxAmountsToTransfer[route.sourceToken]?.[route.sourceChain];
    return isDefined(maxAmount) && amount.gt(maxAmount) ? maxAmount : amount;
  }

  async sendL1ToL2Transfer(
    toAddress: Address,
    l1Token: EvmAddress,
    l2Token: Address,
    amount: BigNumber,
    simMode: boolean
  ): Promise<TransactionResponse> {
    let adapter: RebalancerBinanceStablecoinSwapAdapter;
    let route: RebalanceRoute;
    // Everything up to the initiation call is preflight: no funds can have moved, so any failure here (an
    // unreachable Binance API included) is a decline that lets InventoryClient roll back its balance accounting.
    try {
      [adapter, route] = await this.getAdapterAndRoute(l1Token, l2Token);
      // Binance withdrawals land on the exchange account's withdrawal address, so the only supported recipient is
      // the signer itself.
      assert(adapter.baseSignerAddress.eq(toAddress), "Binance withdrawal recipient must match signer");
      const [pendingOrders, estimatedCost] = await Promise.all([
        adapter.getPendingOrders(),
        adapter.getEstimatedCost(route, amount, false),
      ]);
      if (pendingOrders.length >= getMaxPendingOrders(adapter.config, "binance")) {
        throw new BridgeTransferDeclinedError("Too many pending Binance orders to initiate a new transfer");
      }
      if (estimatedCost.gt(getMaxFee(amount))) {
        throw new BridgeTransferDeclinedError("Estimated Binance transfer cost exceeds the maximum fee");
      }
    } catch (error) {
      if (error instanceof BridgeTransferDeclinedError) {
        throw error;
      }
      // An unexpected preflight failure (bad credentials, missing config, API outage) is safe to treat as a
      // decline, but unlike an expected decline it must be operator-visible: a persistent one silently disables
      // the route otherwise.
      this.logger.error({
        at: "BinanceStablecoinSwapBridge.sendL1ToL2Transfer",
        message: "Binance transfer preflight failed before submission; declining transfer",
        l1Token: l1Token.toNative(),
        l2Token: l2Token.toNative(),
        amount: amount.toString(),
        error,
      });
      throw new BridgeTransferDeclinedError(
        `Binance transfer preflight failed before submission: ${error instanceof Error ? error.message : error}`,
        { cause: error }
      );
    }
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
    if (initializedAmount.eq(bnZero)) {
      throw new BridgeTransferDeclinedError("Binance stablecoin swap adapter declined transfer during initialization");
    }
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
    if (!isDefined(this.adapter)) {
      assert(isDefined(this.adapterFactory), "Binance stablecoin swap adapter factory is required");
      // Memoize the promise, not the resolved adapter, so concurrent transfers share one construction; clear a
      // rejected construction so a transient failure (e.g. Binance API outage) is retried on the next transfer.
      this.adapter = this.adapterFactory(route).catch((error) => {
        this.adapter = undefined;
        throw error;
      });
    }
    const adapter = await this.adapter;
    assert(adapter.supportsRoute(route), "Binance stablecoin swap adapter does not support this route");
    return [adapter, route];
  }
}

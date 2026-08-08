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
   * One-shot initiation: resolves with the Binance deposit transaction hash or rejects with no funds moved and
   * no Redis state created. Every Binance-side failure is deliberately treated like a contract-bridge transaction
   * that failed to mine - no decline/rollback classification exists.
   */
  async sendL1ToL2Transfer(
    toAddress: Address,
    l1Token: EvmAddress,
    l2Token: Address,
    amount: BigNumber,
    simMode: boolean
  ): Promise<TransactionResponse> {
    const [adapter, route] = await this.getAdapterAndRoute(l1Token, l2Token);
    assert(adapter.baseSignerAddress.eq(toAddress), "Binance withdrawal recipient must match signer");
    const maxAmount = await this.getMaxL1ToL2TransferAmount();
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

  async getMaxL1ToL2TransferAmount(): Promise<BigNumber | undefined> {
    if (!isDefined(this.adapterPromise)) {
      return undefined;
    }
    const { config } = await this.adapterPromise;
    return config.maxAmountsToTransfer[getTokenInfo(this.l1Token, this.hubChainId).symbol]?.[this.hubChainId];
  }

  // Binance swap transfers are tracked as Redis orders consumed via RebalancerClient.getPendingRebalances;
  // returning bridge events here would double-count them.
  queryL1BridgeInitiationEvents(): Promise<BridgeEvents> {
    return Promise.resolve({});
  }

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

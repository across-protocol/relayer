import { getContractEntry } from "../../common";
import {
  BigNumber,
  bnZero,
  Contract,
  createFormatFunction,
  EventSearchConfig,
  EvmAddress,
  getNetworkName,
  getTokenInfo,
  isDefined,
  paginatedEventQuery,
  Signer,
  toBN,
  TOKEN_SYMBOLS_MAP,
  winston,
} from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import { ZK_STACK_WITHDRAWAL_LOOKBACK_SECONDS } from "./ZKStackBridge";
import { AugmentedTransaction } from "../../clients/TransactionClient";

/**
 * Withdraws USDC from a ZK Stack chain that uses the standalone ZK Stack USDC bridge (Lens) back to L1.
 *
 * USDC on these chains is unknown to the native token vault (no assetId), so it cannot take the asset router
 * route that ZKStackBridge uses. The standalone bridge pulls the tokens via `transferFrom` and burns them, so
 * it needs an allowance. On L1 the withdrawal is finalized on the standalone L1 USDC bridge via the legacy
 * `finalizeWithdrawal()` entrypoint, which the zkSync finalizer already selects for any (chain, token) pair
 * that `withdrawalRequiresCustomUsdcBridge` recognises.
 *
 * @dev The L2 bridge address is configuration: the token cannot identify it (unlike an L2StandardERC20, the
 * Circle-style USDC token exposes no `l2Bridge()`; the bridge is merely one of its minters). The L1 bridge is
 * not configuration: the L2 bridge names its counterparty via `l1USDCBridge()`, so it is resolved from chain.
 */
export class ZKStackUSDCBridge extends BaseL2BridgeAdapter {
  private l1BridgeResolver?: Promise<Contract>;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l2Signer: Signer,
    l1Signer: Signer,
    l1Token: EvmAddress,
    logger?: winston.Logger
  ) {
    super(l2chainId, hubChainId, l2Signer, l1Signer, l1Token, logger);

    const { address: l2BridgeAddress, abi: l2BridgeAbi } = getContractEntry(l2chainId, "usdcBridge");
    this.l2Bridge = new Contract(l2BridgeAddress, l2BridgeAbi, l2Signer);
  }

  /**
   * @dev Memoised for the lifetime of the instance; the counterparty of an immutable bridge deployment is fixed.
   * Both sides share one ABI, so the L2 interface is reused for the L1 contract.
   */
  protected resolveL1Bridge(): Promise<Contract> {
    return (this.l1BridgeResolver ??= this.getL2Bridge()
      .l1USDCBridge()
      .then((address: string) => new Contract(address, this.getL2Bridge().interface, this.l1Signer)));
  }

  /**
   * @dev The base class translation cannot resolve USDC here: it looks for a bridged-USDC symbol (USDC.e etc.)
   * with an address on this chain, but these chains file their (bridged) USDC under the plain USDC symbol —
   * the same mapping `withdrawalRequiresCustomUsdcBridge` keys the finalizer's routing off.
   */
  override getL2Token(): EvmAddress {
    return EvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[this.l2chainId]);
  }

  constructWithdrawToL1Txns(
    toAddress: EvmAddress,
    l2Token: EvmAddress,
    _l1Token: EvmAddress,
    amount: BigNumber
  ): Promise<AugmentedTransaction[]> {
    const { decimals, symbol } = getTokenInfo(l2Token, this.l2chainId);
    const formatter = createFormatFunction(2, 4, false, decimals);
    const withdrawTxn: AugmentedTransaction = {
      contract: this.getL2Bridge(),
      chainId: this.l2chainId,
      method: "withdraw",
      args: [toAddress.toNative(), l2Token.toNative(), amount],
      nonMulticall: true,
      message: "🎰 Withdrew ZK Stack USDC to L1",
      mrkdwn: `Withdrew ${formatter(amount.toString())} ${symbol} from ${getNetworkName(this.l2chainId)} to L1`,
    };
    return Promise.resolve([withdrawTxn]);
  }

  async getL2PendingWithdrawalAmount(
    l2EventConfig: EventSearchConfig,
    l1EventConfig: EventSearchConfig,
    fromAddress: EvmAddress,
    l2Token: EvmAddress
  ): Promise<BigNumber> {
    const l1Bridge = await this.resolveL1Bridge();

    // Unlike the native token vault events, both sides index the addresses needed to scope the query fully:
    // the L2 bridge indexes the initiating sender and the L1 bridge indexes the source chain and receiver.
    const [withdrawalInitiatedEvents, withdrawalFinalizedEvents] = await Promise.all([
      paginatedEventQuery(
        this.getL2Bridge(),
        this.getL2Bridge().filters.WithdrawalInitiated(fromAddress.toNative(), null, l2Token.toNative()),
        l2EventConfig
      ),
      paginatedEventQuery(
        l1Bridge,
        l1Bridge.filters.WithdrawalFinalizedSharedBridge(
          this.l2chainId,
          fromAddress.toNative(),
          this.l1Token.toNative()
        ),
        l1EventConfig
      ),
    ]);

    const counted = new Set<number>();
    return withdrawalInitiatedEvents.reduce((totalAmount, { args: l2Args }) => {
      const received = withdrawalFinalizedEvents.find(({ args: l1Args }, idx) => {
        // Protect against double-counting the same L1 finalization against two equally-sized L2 withdrawals.
        if (counted.has(idx) || !toBN(l1Args.amount.toString()).eq(toBN(l2Args.amount.toString()))) {
          return false;
        }

        counted.add(idx);
        return true;
      });

      return isDefined(received) ? totalAmount : totalAmount.add(l2Args.amount);
    }, bnZero);
  }

  public requiredTokenApprovals(): { token: EvmAddress; bridge: EvmAddress }[] {
    return [
      {
        token: EvmAddress.from(this.getL2Token().toNative()),
        bridge: EvmAddress.from(this.getL2Bridge().address),
      },
    ];
  }

  public pendingWithdrawalLookbackPeriodSeconds(): number {
    return ZK_STACK_WITHDRAWAL_LOOKBACK_SECONDS;
  }
}

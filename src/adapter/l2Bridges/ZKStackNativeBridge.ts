import { PUBLIC_NETWORKS } from "@across-protocol/constants";
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
  paginatedEventQuery,
  Signer,
  winston,
} from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import { AugmentedTransaction } from "../../clients/TransactionClient";

// See ZKStackBridge; the same batch-execution delay applies to base token withdrawals.
const ZK_STACK_WITHDRAWAL_LOOKBACK_SECONDS = 24 * 60 * 60;

/**
 * Withdraws a ZK Stack chain's wrapped native token back to L1.
 *
 * The wrapped native token cannot go through the asset router — the native token vault refuses to burn it
 * (`BurningNativeWETHNotSupported`) — so it has to be unwrapped into the base token first and then withdrawn
 * through the L2BaseToken system contract. That means the funds arrive on L1 as the *unwrapped* native asset.
 *
 * @dev This is only wired up for chains whose base token is ETH (i.e. zkSync Era), because the relayer already
 * re-wraps ETH into WETH on the hub chain (`AdapterManager.chainsToWrapEtherOn` includes MAINNET). On a chain with
 * a non-ETH base token (Lens, whose base token is WGHO) the withdrawal would land as unwrapped L1 GHO, which the
 * inventory book — keyed on L1 WGHO — neither tracks nor re-wraps. Wiring Lens up needs that gap closed first.
 */
export class ZKStackNativeBridge extends BaseL2BridgeAdapter {
  // The L2BaseToken system contract is both the transaction target and the event source; the wrapped native
  // token is only used for the unwrap leg.
  protected readonly wrappedNativeToken: Contract;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l2Signer: Signer,
    l1Signer: Signer,
    l1Token: EvmAddress,
    logger?: winston.Logger
  ) {
    super(l2chainId, hubChainId, l2Signer, l1Signer, l1Token, logger);

    const { address: baseTokenAddress, abi: baseTokenAbi } = getContractEntry(l2chainId, "l2BaseToken");
    this.l2Bridge = new Contract(baseTokenAddress, baseTokenAbi, l2Signer);

    // The chain's wrapped native token is registered as `weth` where the base token is ETH and as
    // `wrappedNativeToken` otherwise. Mirrors the L1->L2 ZKStackBridge, which keys off the same field.
    const wrappedNativeTokenEntry = PUBLIC_NETWORKS[l2chainId].nativeToken === "ETH" ? "weth" : "wrappedNativeToken";
    const { address: wrappedAddress, abi: wrappedAbi } = getContractEntry(l2chainId, wrappedNativeTokenEntry);
    this.wrappedNativeToken = new Contract(wrappedAddress, wrappedAbi, l2Signer);
  }

  constructWithdrawToL1Txns(
    toAddress: EvmAddress,
    l2Token: EvmAddress,
    _l1Token: EvmAddress,
    amount: BigNumber
  ): Promise<AugmentedTransaction[]> {
    const { decimals, symbol } = getTokenInfo(l2Token, this.l2chainId);
    const formatter = createFormatFunction(2, 4, false, decimals);
    const networkName = getNetworkName(this.l2chainId);

    const unwrapTxn: AugmentedTransaction = {
      contract: this.wrappedNativeToken,
      chainId: this.l2chainId,
      method: "withdraw",
      args: [amount],
      nonMulticall: true,
      // The withdrawal below spends the proceeds of this transaction, so it must land first.
      ensureConfirmation: true,
      message: "🎰 Unwrapped ZK Stack native token",
      mrkdwn: `Unwrapped ${formatter(amount.toString())} ${symbol} on ${networkName} ahead of withdrawing to L1`,
    };

    const withdrawTxn: AugmentedTransaction = {
      contract: this.getL2Bridge(),
      chainId: this.l2chainId,
      method: "withdraw",
      args: [toAddress.toNative()],
      value: amount,
      nonMulticall: true,
      // Simulated before the unwrap above has landed, so the balance is not yet there.
      canFailInSimulation: true,
      message: "🎰 Withdrew ZK Stack native token to L1",
      mrkdwn: `Withdrew ${formatter(amount.toString())} ${symbol} from ${networkName} to L1`,
    };

    return Promise.resolve([unwrapTxn, withdrawTxn]);
  }

  /**
   * @dev Unlike the ERC20 path there is no L1-side event to reconcile against: the base token is released as a
   * plain native transfer, which emits nothing. Every withdrawal inside the lookback window is therefore counted
   * as still pending. That over-counts recently-finalized withdrawals, which is the safe direction to err in —
   * it suppresses a duplicate withdrawal rather than causing one.
   */
  async getL2PendingWithdrawalAmount(
    l2EventConfig: EventSearchConfig,
    _l1EventConfig: EventSearchConfig,
    fromAddress: EvmAddress,
    _l2Token: EvmAddress
  ): Promise<BigNumber> {
    const withdrawalInitiatedEvents = await paginatedEventQuery(
      this.getL2Bridge(),
      this.getL2Bridge().filters.Withdrawal(fromAddress.toNative()),
      l2EventConfig
    );

    return withdrawalInitiatedEvents.reduce((totalAmount, { args }) => totalAmount.add(args._amount), bnZero);
  }

  public pendingWithdrawalLookbackPeriodSeconds(): number {
    return ZK_STACK_WITHDRAWAL_LOOKBACK_SECONDS;
  }
}

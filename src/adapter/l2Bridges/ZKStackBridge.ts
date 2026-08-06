import { getContractEntry } from "../../common";
import {
  BigNumber,
  bnZero,
  compareAddressesSimple,
  Contract,
  createFormatFunction,
  ethers,
  EventSearchConfig,
  EvmAddress,
  getNetworkName,
  getTokenInfo,
  isDefined,
  paginatedEventQuery,
  Signer,
  toBN,
  winston,
  ZERO_BYTES,
} from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import { AugmentedTransaction } from "../../clients/TransactionClient";

// A ZK Stack withdrawal is only claimable on L1 once the batch containing it has been executed. The finalizer
// waits 6 hours before it even attempts to finalize (see src/finalizer/utils/zkSync.ts), so allow generous
// headroom on top of that so that in-flight withdrawals are not double-counted as spendable inventory.
const ZK_STACK_WITHDRAWAL_LOOKBACK_SECONDS = 24 * 60 * 60;

/**
 * Withdraws ERC20s from a ZK Stack chain (zkSync Era, Lens) back to L1 via the L2 asset router.
 *
 * The asset router exposes two withdrawal entrypoints. We deliberately use `withdraw(bytes32,bytes)` rather than
 * the legacy `withdraw(address,address,uint256)`:
 *   - it works for both L1-origin (bridged) and L2-origin (native) tokens, whereas the legacy entrypoint reverts
 *     with `TokenNotLegacy()` for the latter;
 *   - it routes the L2->L1 message through the asset router itself, so `params.sender` on L1 is the asset router.
 *     `useLegacyFinalizeWithdrawal` in the finalizer keys off exactly that to pick `finalizeDeposit` (which passes
 *     `l2Sender` explicitly) over the legacy `finalizeWithdrawal` (which has to assume it). The legacy entrypoint
 *     instead emits from the legacy shared bridge, which would need the opposite L1 entrypoint.
 * Keeping a single L2 path therefore keeps a single, correct L1 path.
 */
export class ZKStackBridge extends BaseL2BridgeAdapter {
  // The asset router is the transaction target. The native token vault (`l2Bridge`) is both the assetId registry
  // and the emitter of the BridgeBurn event used to track pending withdrawals; its L1 counterpart (`l1Bridge`)
  // emits the matching BridgeMint on finalization.
  protected readonly assetRouter: Contract;

  private assetId?: Promise<string>;
  private nativeWrapper?: Promise<string>;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l2Signer: Signer,
    l1Signer: Signer,
    l1Token: EvmAddress,
    logger?: winston.Logger
  ) {
    super(l2chainId, hubChainId, l2Signer, l1Signer, l1Token, logger);

    const { address: assetRouterAddress, abi: assetRouterAbi } = getContractEntry(l2chainId, "assetRouter");
    this.assetRouter = new Contract(assetRouterAddress, assetRouterAbi, l2Signer);

    const { address: l2VaultAddress, abi: l2VaultAbi } = getContractEntry(l2chainId, "nativeTokenVault");
    this.l2Bridge = new Contract(l2VaultAddress, l2VaultAbi, l2Signer);

    const { address: l1VaultAddress, abi: l1VaultAbi } = getContractEntry(hubChainId, "zkStackNativeTokenVault");
    this.l1Bridge = new Contract(l1VaultAddress, l1VaultAbi, l1Signer);
  }

  /**
   * @dev One bridge instance is constructed per l1Token, so both of these are constant for the lifetime of the
   * instance and are memoised to keep withdrawal construction cheap on the hot path.
   */
  protected resolveAssetId(l2Token: EvmAddress): Promise<string> {
    return (this.assetId ??= this.getL2Bridge().assetId(l2Token.toNative()));
  }

  protected resolveNativeWrapper(): Promise<string> {
    return (this.nativeWrapper ??= this.getL2Bridge().WETH_TOKEN());
  }

  async constructWithdrawToL1Txns(
    toAddress: EvmAddress,
    l2Token: EvmAddress,
    _l1Token: EvmAddress,
    amount: BigNumber
  ): Promise<AugmentedTransaction[]> {
    const [assetId, nativeWrapper] = await Promise.all([this.resolveAssetId(l2Token), this.resolveNativeWrapper()]);

    // A token that has never been bridged has no assetId, and the vault explicitly refuses to burn the chain's own
    // wrapped native token (`BurningNativeWETHNotSupported`). The latter is checked separately because a token can
    // be registered (non-zero assetId) and still be unburnable.
    if (assetId === ZERO_BYTES || compareAddressesSimple(l2Token.toNative(), nativeWrapper)) {
      this.logger?.warn({
        at: "ZKStackBridge#constructWithdrawToL1Txns",
        message: `Cannot withdraw ${l2Token} from ${getNetworkName(this.l2chainId)} via the asset router.`,
        mrkdwn:
          "The token is either unregistered in the native token vault or is the chain's wrapped native token," +
          " which the vault refuses to burn. It needs a dedicated bridge.",
        l2Token,
        assetId,
        nativeWrapper,
      });
      return [];
    }

    // NativeTokenVault.decodeBridgeBurnData expects exactly (uint256 amount, address l1Receiver, address l2Token);
    // anything else reverts with InvalidNTVBurnData().
    const assetData = ethers.utils.defaultAbiCoder.encode(
      ["uint256", "address", "address"],
      [amount, toAddress.toNative(), l2Token.toNative()]
    );

    const { decimals, symbol } = getTokenInfo(l2Token, this.l2chainId);
    const formatter = createFormatFunction(2, 4, false, decimals);
    const withdrawTxn: AugmentedTransaction = {
      contract: this.assetRouter,
      chainId: this.l2chainId,
      method: "withdraw",
      args: [assetId, assetData],
      nonMulticall: true,
      message: "🎰 Withdrew ZK Stack ERC20 to L1",
      mrkdwn: `Withdrew ${formatter(amount.toString())} ${symbol} from ${getNetworkName(this.l2chainId)} to L1`,
    };
    return [withdrawTxn];
  }

  async getL2PendingWithdrawalAmount(
    l2EventConfig: EventSearchConfig,
    l1EventConfig: EventSearchConfig,
    fromAddress: EvmAddress,
    l2Token: EvmAddress
  ): Promise<BigNumber> {
    const assetId = await this.resolveAssetId(l2Token);
    if (assetId === ZERO_BYTES) {
      return bnZero;
    }

    // On the withdrawal leg the burn happens on L2 and the mint on L1, so each side is filtered on its
    // counterparty chain: the L2 vault burns "to" the hub chain and the L1 vault mints "from" the L2 chain.
    // This mirrors the deposit leg in src/adapter/bridges/ZKStackBridge.ts, with the chain ids swapped.
    const [withdrawalInitiatedEvents, withdrawalFinalizedEvents] = await Promise.all([
      paginatedEventQuery(
        this.getL2Bridge(),
        this.getL2Bridge().filters.BridgeBurn(this.hubChainId, assetId, fromAddress.toNative()),
        l2EventConfig
      ),
      paginatedEventQuery(
        this.getL1Bridge(),
        // `receiver` is not indexed, so it is filtered below rather than in the topic set.
        this.getL1Bridge().filters.BridgeMint(this.l2chainId, assetId),
        l1EventConfig
      ),
    ]);

    const counted = new Set<number>();
    return withdrawalInitiatedEvents.reduce((totalAmount, { args: l2Args }) => {
      const received = withdrawalFinalizedEvents.find(({ args: l1Args }, idx) => {
        // Protect against double-counting the same L1 finalization against two equally-sized L2 withdrawals.
        if (
          counted.has(idx) ||
          !compareAddressesSimple(l1Args.receiver, fromAddress.toNative()) ||
          !toBN(l1Args.amount.toString()).eq(toBN(l2Args.amount.toString()))
        ) {
          return false;
        }

        counted.add(idx);
        return true;
      });

      return isDefined(received) ? totalAmount : totalAmount.add(l2Args.amount);
    }, bnZero);
  }

  /**
   * @dev The vault pulls L2-origin tokens via `safeTransferFrom`, so it needs an allowance. L1-origin (bridged)
   * tokens are burned directly and need none, but the allowance is requested unconditionally: it is set at most
   * once per token (the result is cached in Redis) and we cannot tell the two cases apart synchronously.
   */
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

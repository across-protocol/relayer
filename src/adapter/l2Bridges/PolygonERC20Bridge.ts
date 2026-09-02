import { EventFilter } from "ethers";
import { getContractEntry, getContractAbi } from "../../common";
import {
  assert,
  BigNumber,
  bnZero,
  Contract,
  createFormatFunction,
  EventSearchConfig,
  getNetworkName,
  getTokenInfo,
  isDefined,
  paginatedEventQuery,
  Signer,
  toBN,
  EvmAddress,
  ZERO_ADDRESS,
} from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import { AugmentedTransaction } from "../../clients/TransactionClient";

/**
 * Withdraws standard Polygon PoS bridged ERC20s (WETH, WBTC, ...) back to the hub chain.
 *
 * @dev This is the chain-level default for Polygon. Tokens with a faster/cheaper exit (USDC over CCTP, USDT over
 * OFT) are registered in CUSTOM_L2_BRIDGE, which takes precedence over CANONICAL_L2_BRIDGE.
 *
 * The PoS exit is two steps: `withdraw(amount)` burns the child token on Polygon, and after the burn is
 * checkpointed to mainnet `RootChainManager.exit(proof)` releases the root token. Only the burn happens here —
 * the exit is completed by `polygonFinalizer`, which discovers EOA burns via `addressesToFinalize`. A burn with
 * no corresponding finalizer coverage would never be claimed on L1, so the two must stay in step.
 */
export class PolygonERC20Bridge extends BaseL2BridgeAdapter {
  private readonly signer: Signer;

  constructor(l2chainId: number, hubChainId: number, l2Signer: Signer, l1Signer: Signer, l1Token: EvmAddress) {
    super(l2chainId, hubChainId, l2Signer, l1Signer, l1Token);
    this.signer = l2Signer;

    // The child token *is* the bridge on Polygon: `withdraw()` burns the caller's balance directly on the token.
    const l2Token = this.getL2Token();
    this.l2Bridge = new Contract(l2Token.toNative(), getContractAbi(l2chainId, "withdrawableErc20"), l2Signer);

    // ERC20Predicate on the hub chain, which emits ExitedERC20 once a burn has been claimed.
    const { address: l1Address, abi: l1Abi } = getContractEntry(hubChainId, "polygonBridge");
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);
  }

  /**
   * Filter for the hub-chain event marking a burn as claimed. The predicate that releases the root token depends on
   * how the child token is mapped, so ether-mapped tokens (WETH) override this along with the l1Bridge binding.
   */
  protected exitedEventFilter(fromAddress: EvmAddress): EventFilter {
    return this.getL1Bridge().filters.ExitedERC20(fromAddress.toNative(), this.l1Token.toNative());
  }

  async constructWithdrawToL1Txns(
    toAddress: EvmAddress,
    l2Token: EvmAddress,
    _l1Token: EvmAddress,
    amount: BigNumber
  ): Promise<AugmentedTransaction[]> {
    // `withdraw()` takes no recipient: the PoS exit always credits the address that burned the tokens. Callers
    // withdraw to the relayer's own address, so this holds today, but assert rather than silently sending
    // someone else's funds to the signer.
    const signerAddress = await this.signer.getAddress();
    assert(
      toAddress.eq(EvmAddress.from(signerAddress)),
      `Polygon PoS withdrawals always exit to the burner (${signerAddress}); cannot withdraw to ${toAddress.toNative()}`
    );

    const { decimals, symbol } = getTokenInfo(l2Token, this.l2chainId);
    const formatter = createFormatFunction(2, 4, false, decimals);
    const withdrawTxn: AugmentedTransaction = {
      contract: this.getL2Bridge(),
      chainId: this.l2chainId,
      method: "withdraw",
      args: [amount],
      nonMulticall: true,
      message: "🎰 Withdrew Polygon ERC20 to L1",
      mrkdwn:
        `Withdrew ${formatter(amount.toString())} ${symbol} ${getNetworkName(this.l2chainId)} to L1. ` +
        "Exit is claimed on mainnet by the finalizer once the burn is checkpointed.",
    };
    return [withdrawTxn];
  }

  async getL2PendingWithdrawalAmount(
    l2EventConfig: EventSearchConfig,
    l1EventConfig: EventSearchConfig,
    fromAddress: EvmAddress,
    l2Token: EvmAddress
  ): Promise<BigNumber> {
    // A PoS withdrawal is a burn: Transfer(fromAddress -> 0x0) on the child token. It is outstanding until the
    // matching ExitedERC20 lands on the hub chain.
    assert(
      l2Token.eq(this.getL2Token()),
      `Unexpected l2Token ${l2Token.toNative()} for Polygon bridge on ${this.getL2Token().toNative()}`
    );
    const [burnEvents, exitedEvents] = await Promise.all([
      paginatedEventQuery(
        this.getL2Bridge(),
        this.getL2Bridge().filters.Transfer(fromAddress.toNative(), ZERO_ADDRESS),
        l2EventConfig
      ),
      paginatedEventQuery(this.getL1Bridge(), this.exitedEventFilter(fromAddress), l1EventConfig),
    ]);

    // Match each burn against at most one exit of the same size, mirroring OpStackBridge.
    const counted = new Set<number>();
    return burnEvents.reduce((totalAmount, { args: l2Args }) => {
      const exited = exitedEvents.find(({ args: l1Args }, idx) => {
        if (counted.has(idx) || !toBN(l1Args.amount.toString()).eq(toBN(l2Args.value.toString()))) {
          return false;
        }
        counted.add(idx);
        return true;
      });
      return isDefined(exited) ? totalAmount : totalAmount.add(l2Args.value);
    }, bnZero);
  }

  public pendingWithdrawalLookbackPeriodSeconds(): number {
    // Polygon checkpoints land in well under an hour normally, but can lag during congestion. A day is
    // comfortably longer than any observed checkpoint interval while keeping the burn/exit matching window tight.
    return 24 * 60 * 60;
  }
}

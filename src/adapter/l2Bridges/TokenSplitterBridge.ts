import {
  BigNumber,
  EventSearchConfig,
  Signer,
  EvmAddress,
  getTranslatedTokenAddress,
  SolanaTransaction,
} from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import { AugmentedTransaction } from "../../clients/TransactionClient";
import { L2_TOKEN_SPLITTER_BRIDGES } from "../../common";

export class TokenSplitterBridge extends BaseL2BridgeAdapter {
  protected bridge1;
  protected bridge2;

  constructor(l2chainId: number, hubChainId: number, l2Signer: Signer, l1Signer: Signer, l1Token: EvmAddress) {
    super(l2chainId, hubChainId, l2Signer, l1Signer, l1Token);

    const [bridge1Constructor, bridge2Constructor] = L2_TOKEN_SPLITTER_BRIDGES[this.l2chainId][this.l1Token.toNative()];
    this.bridge1 = new bridge1Constructor(l2chainId, hubChainId, l2Signer, l1Signer, l1Token);
    this.bridge2 = new bridge2Constructor(l2chainId, hubChainId, l2Signer, l1Signer, l1Token);
  }

  getRouteForL2Token(l2Token: EvmAddress): BaseL2BridgeAdapter {
    return getTranslatedTokenAddress(this.l1Token, this.hubChainId, this.l2chainId).eq(l2Token)
      ? this.bridge1
      : this.bridge2;
  }

  async constructWithdrawToL1Txns(
    toAddress: EvmAddress,
    l2Token: EvmAddress,
    l1Token: EvmAddress,
    amount: BigNumber
  ): Promise<AugmentedTransaction[] | SolanaTransaction[]> {
    return this.getRouteForL2Token(l2Token).constructWithdrawToL1Txns(toAddress, l2Token, l1Token, amount);
  }

  async getL2PendingWithdrawalAmount(
    l2EventConfig: EventSearchConfig,
    l1EventConfig: EventSearchConfig,
    fromAddress: EvmAddress,
    l2Token: EvmAddress
  ): Promise<BigNumber> {
    const [bridge1Pending, bridge2Pending] = await Promise.all([
      this.bridge1.getL2PendingWithdrawalAmount(l2EventConfig, l1EventConfig, fromAddress, l2Token),
      this.bridge2.getL2PendingWithdrawalAmount(l2EventConfig, l1EventConfig, fromAddress, l2Token),
    ]);
    return bridge1Pending.add(bridge2Pending);
  }
}

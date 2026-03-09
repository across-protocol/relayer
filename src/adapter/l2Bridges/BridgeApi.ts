import {
  BigNumber,
  bnZero,
  Contract,
  EventSearchConfig,
  getNetworkName,
  Signer,
  EvmAddress,
  CHAIN_IDs,
} from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import { AugmentedTransaction } from "../../clients/TransactionClient";
import { BRIDGE_API_MINIMUMS } from "../../adapter/bridges";

export class BridgeApi extends BaseL2BridgeAdapter {
  constructor(l2chainId: number, hubChainId: number, l2Signer: Signer, l1Signer: Signer, l1Token: EvmAddress) {
    if (hubChainId !== CHAIN_IDs.MAINNET) {
      throw new Error("Cannot define a Bridge API bridge for a non-production network");
    }
    super(l2chainId, hubChainId, l2Signer, l1Signer, l1Token);
  }

  async constructWithdrawToL1Txns(
    _toAddress: EvmAddress,
    l2Token: EvmAddress,
    _l1Token: EvmAddress,
    amount: BigNumber
  ): Promise<AugmentedTransaction[]> {
    // If amount is less than the network minimums, then throw.
    if (amount.lt(BRIDGE_API_MINIMUMS[this.hubChainId])) {
      throw new Error(`Cannot bridge to ${getNetworkName(this.hubChainId)} due to invalid amount ${amount}`);
    }
    // Get the transfer route source address. @todo
    const transferRouteSource = await this.l1Signer.getAddress();
    const transferTxn = {
      contract: new Contract(transferRouteSource, []),
      method: "transfer",
      chainId: this.l2chainId,
      args: [transferRouteSource, amount],
    };
    return [transferTxn];
  }

  async getL2PendingWithdrawalAmount(
    _l2EventConfig: EventSearchConfig,
    _l1EventConfig: EventSearchConfig,
    _fromAddress: EvmAddress,
    _l2Token: EvmAddress
  ): Promise<BigNumber> {
    // @todo
    return Promise.resolve(bnZero);
  }
}

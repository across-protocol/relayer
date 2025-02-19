import { CONTRACT_ADDRESSES } from "../../common";
import { BigNumber, Contract, createFormatFunction, getL1TokenInfo, getNetworkName, Signer } from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import { AugmentedTransaction } from "../../clients/TransactionClient";

export class ArbitrumOrbitNativeTokenBridge extends BaseL2BridgeAdapter {
  constructor(l2chainId: number, hubChainId: number, l2Signer: Signer) {
    super(l2chainId, hubChainId, l2Signer);

    const { address, abi } = CONTRACT_ADDRESSES[l2chainId].arbSys;
    this.l2Bridge = new Contract(address, abi, l2Signer);
  }

  constructWithdrawToL1Txns(
    toAddress: string,
    l2Token: string,
    _l1Token: string,
    amount: BigNumber
  ): AugmentedTransaction[] {
    const l1TokenInfo = getL1TokenInfo(l2Token, this.l2chainId);
    const formatter = createFormatFunction(2, 4, false, l1TokenInfo.decimals);
    const withdrawTxn: AugmentedTransaction = {
      contract: this.l2Bridge,
      chainId: this.l2chainId,
      method: "withdrawEth",
      args: [
        toAddress, // to
      ],
      value: amount,
      nonMulticall: true,
      message: "🎰 Withdrew Orbit native gas token to L1",
      mrkdwn: `Withdrew ${formatter(amount.toString())} ${l1TokenInfo.symbol} from ${getNetworkName(
        this.l2chainId
      )} to L1`,
    };
    return [withdrawTxn];
  }
}

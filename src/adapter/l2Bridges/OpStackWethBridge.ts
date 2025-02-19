import { CONTRACT_ADDRESSES } from "../../common";
import {
  BigNumber,
  bnZero,
  Contract,
  createFormatFunction,
  EventSearchConfig,
  getL1TokenInfo,
  getNetworkName,
  paginatedEventQuery,
  Signer,
} from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import WETH_ABI from "../../common/abi/Weth.json";
import { AugmentedTransaction } from "../../clients/TransactionClient";

export class OpStackWethBridge extends BaseL2BridgeAdapter {
  constructor(l2chainId: number, hubChainId: number, l2Signer: Signer) {
    super(l2chainId, hubChainId, l2Signer);

    const { address, abi } = CONTRACT_ADDRESSES[l2chainId].ovmStandardBridge;
    this.l2Bridge = new Contract(address, abi, l2Signer);
  }

  constructWithdrawToL1Txns(
    toAddress: string,
    l2Token: string,
    _l1Token: string,
    amount: BigNumber
  ): AugmentedTransaction[] {
    const weth = new Contract(l2Token, WETH_ABI, this.l2Signer);
    const l1TokenInfo = getL1TokenInfo(l2Token, this.l2chainId);
    const formatter = createFormatFunction(2, 4, false, l1TokenInfo.decimals);
    const unwrapTxn: AugmentedTransaction = {
      contract: weth,
      chainId: this.l2chainId,
      method: "withdraw",
      args: [amount],
      nonMulticall: true,
      message: "🎰 Unwrapped WETH on OpStack before withdrawing to L1",
      mrkdwn: `Unwrapped ${formatter(amount.toString())} WETH before withdrawing from ${getNetworkName(
        this.l2chainId
      )} to L1`,
    };
    const withdrawTxn: AugmentedTransaction = {
      contract: this.l2Bridge,
      chainId: this.l2chainId,
      method: "bridgeETHTo",
      args: [
        toAddress, // to
        200_000, // minGasLimit
        "0x", // extraData
      ],
      nonMulticall: true,
      value: amount,
      message: "🎰 Withdrew OpStack WETH to L1",
      mrkdwn: `Withdrew ${formatter(amount.toString())} ${l1TokenInfo.symbol} from ${getNetworkName(
        this.l2chainId
      )} to L1`,
    };
    return [unwrapTxn, withdrawTxn];
  }

  async getL2WithdrawalAmount(
    eventConfig: EventSearchConfig,
    fromAddress: string,
    _l2Token: string
  ): Promise<BigNumber> {
    _l2Token; // unused
    const withdrawalEvents = await paginatedEventQuery(
      this.l2Bridge,
      this.l2Bridge.filters.ETHBridgeInitiated(
        fromAddress // from
      ),
      eventConfig
    );
    const withdrawalAmount = withdrawalEvents.reduce((totalAmount, event) => {
      return totalAmount.add(event.args.amount);
    }, bnZero);
    return withdrawalAmount;
  }
}

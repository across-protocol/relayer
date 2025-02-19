import { CONTRACT_ADDRESSES } from "../../common";
import {
  BigNumber,
  Contract,
  createFormatFunction,
  EventSearchConfig,
  getL1TokenInfo,
  getNetworkName,
  paginatedEventQuery,
  Signer,
} from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import { AugmentedTransaction } from "../../clients/TransactionClient";
import ARBITRUM_ERC20_GATEWAY_L2_ABI from "../../common/abi/ArbitrumErc20GatewayL2.json";

export class ArbitrumOrbitBridge extends BaseL2BridgeAdapter {
  constructor(l2chainId: number, hubChainId: number, l2Signer: Signer) {
    super(l2chainId, hubChainId, l2Signer);

    const { address, abi } = CONTRACT_ADDRESSES[l2chainId].erc20GatewayRouter;
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
      method: "outboundTransfer",
      args: [
        l1TokenInfo.address, // l1Token
        toAddress, // to
        amount, // amount
        "0x", // data
      ],
      nonMulticall: true,
      message: "🎰 Withdrew Orbit ERC20 to L1",
      mrkdwn: `Withdrew ${formatter(amount.toString())} ${l1TokenInfo.symbol} from ${getNetworkName(
        this.l2chainId
      )} to L1`,
    };
    return [withdrawTxn];
  }

  async getL2WithdrawalAmount(
    eventConfig: EventSearchConfig,
    fromAddress: string,
    l2Token: string
  ): Promise<BigNumber> {
    const l1TokenInfo = getL1TokenInfo(l2Token, this.l2chainId);
    const erc20GatewayForToken = await this.l2Bridge.getGateway(l1TokenInfo.address);
    const gatewayContract = new Contract(erc20GatewayForToken, ARBITRUM_ERC20_GATEWAY_L2_ABI, this.l2Signer);
    const withdrawalEvents = await paginatedEventQuery(
      gatewayContract,
      gatewayContract.filters.WithdrawalInitiated(
        null, // l1Token non-indexed
        fromAddress // from
      ),
      eventConfig
    );
    const withdrawalAmount = withdrawalEvents.reduce((totalAmount, event) => {
      if (event.args.l1Token === l1TokenInfo.address) {
        return totalAmount.add(event.args._amount);
      }
      return totalAmount;
    }, BigNumber.from(0));
    return withdrawalAmount;
  }
}

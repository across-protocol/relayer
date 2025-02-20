import { CONTRACT_ADDRESSES } from "../../common";
import {
  BigNumber,
  bnZero,
  Contract,
  createFormatFunction,
  EventSearchConfig,
  getL1TokenInfo,
  getNetworkName,
  isDefined,
  paginatedEventQuery,
  Provider,
  Signer,
  toBN,
} from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import { AugmentedTransaction } from "../../clients/TransactionClient";

export class OpStackBridge extends BaseL2BridgeAdapter {
  constructor(l2chainId: number, hubChainId: number, l2Signer: Signer, l1Provider: Provider | Signer, l1Token: string) {
    super(l2chainId, hubChainId, l2Signer, l1Provider, l1Token);

    const { address, abi } = CONTRACT_ADDRESSES[l2chainId].ovmStandardBridge;
    this.l2Bridge = new Contract(address, abi, l2Signer);
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId][`ovmStandardBridge_${l2chainId}`];
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Provider);
  }

  constructWithdrawToL1Txns(
    toAddress: string,
    l2Token: string,
    l1Token: string,
    amount: BigNumber
  ): AugmentedTransaction[] {
    const l1TokenInfo = getL1TokenInfo(l2Token, this.l2chainId);
    const formatter = createFormatFunction(2, 4, false, l1TokenInfo.decimals);
    const withdrawTxn: AugmentedTransaction = {
      contract: this.l2Bridge,
      chainId: this.l2chainId,
      method: "bridgeERC20To",
      args: [
        l2Token, // _localToken
        l1Token, // Remote token to be received on L1 side. If the
        // remoteL1Token on the other chain does not recognize the local token as the correct
        // pair token, the ERC20 bridge will fail and the tokens will be returned to sender on
        // this chain.
        toAddress, // _to
        amount, // _amount
        200_000, // minGasLimit
        "0x", // _data
      ],
      nonMulticall: true,
      message: "🎰 Withdrew OpStack ERC20 to L1",
      mrkdwn: `Withdrew ${formatter(amount.toString())} ${l1TokenInfo.symbol} ${getNetworkName(this.l2chainId)} to L1`,
    };
    return [withdrawTxn];
  }

  async getL2PendingWithdrawalAmount(
    l2EventConfig: EventSearchConfig,
    l1EventConfig: EventSearchConfig,
    fromAddress: string,
    l2Token: string
  ): Promise<BigNumber> {
    const [withdrawalInitiatedEvents, withdrawalFinalizedEvents] = await Promise.all([
      paginatedEventQuery(
        this.l2Bridge,
        this.l2Bridge.filters.ERC20BridgeInitiated(
          l2Token, // localToken
          null, // remoteToken
          fromAddress // from
        ),
        l2EventConfig
      ),
      paginatedEventQuery(
        this.l1Bridge,
        this.l1Bridge.filters.ERC20BridgeFinalized(
          null, // localToken
          l2Token, // remoteToken
          fromAddress // from
        ),
        l1EventConfig
      ),
    ]);
    const withdrawalAmount = withdrawalInitiatedEvents.reduce((totalAmount, event) => {
      const matchingFinalizedEvent = withdrawalFinalizedEvents.find((e) =>
        toBN(e.args.amount.toString()).eq(toBN(event.args.amount.toString()))
      );
      if (!isDefined(matchingFinalizedEvent)) {
        return totalAmount.add(event.args.amount);
      }
      return totalAmount;
    }, bnZero);
    return withdrawalAmount;
  }
}

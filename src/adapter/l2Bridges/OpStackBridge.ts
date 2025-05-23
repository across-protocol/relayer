import { CONTRACT_ADDRESSES } from "../../common";
import {
  BigNumber,
  bnZero,
  Contract,
  createFormatFunction,
  EventSearchConfig,
  getNetworkName,
  isDefined,
  paginatedEventQuery,
  Provider,
  Signer,
  toBN,
  EvmAddress,
  getTokenInfo,
} from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import { AugmentedTransaction } from "../../clients/TransactionClient";

export class OpStackBridge extends BaseL2BridgeAdapter {
  constructor(
    l2chainId: number,
    hubChainId: number,
    l2Signer: Signer,
    l1Provider: Provider | Signer,
    l1Token: EvmAddress
  ) {
    super(l2chainId, hubChainId, l2Signer, l1Provider, l1Token);

    const { address, abi } = CONTRACT_ADDRESSES[l2chainId].ovmStandardBridge;
    this.l2Bridge = new Contract(address, abi, l2Signer);
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId][`ovmStandardBridge_${l2chainId}`];
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Provider);
  }

  constructWithdrawToL1Txns(
    toAddress: EvmAddress,
    l2Token: EvmAddress,
    l1Token: EvmAddress,
    amount: BigNumber
  ): Promise<AugmentedTransaction[]> {
    const { decimals, symbol } = getTokenInfo(l2Token.toAddress(), this.l2chainId);
    const formatter = createFormatFunction(2, 4, false, decimals);
    const withdrawTxn: AugmentedTransaction = {
      contract: this.l2Bridge,
      chainId: this.l2chainId,
      method: "bridgeERC20To",
      args: [
        l2Token.toAddress(), // _localToken
        l1Token.toAddress(), // Remote token to be received on L1 side. If the
        // remoteL1Token on the other chain does not recognize the local token as the correct
        // pair token, the ERC20 bridge will fail and the tokens will be returned to sender on
        // this chain.
        toAddress.toAddress(), // _to
        amount, // _amount
        200_000, // minGasLimit
        "0x", // _data
      ],
      nonMulticall: true,
      message: "🎰 Withdrew OpStack ERC20 to L1",
      mrkdwn: `Withdrew ${formatter(amount.toString())} ${symbol} ${getNetworkName(this.l2chainId)} to L1`,
    };
    return Promise.resolve([withdrawTxn]);
  }

  async getL2PendingWithdrawalAmount(
    l2EventConfig: EventSearchConfig,
    l1EventConfig: EventSearchConfig,
    fromAddress: EvmAddress,
    l2Token: EvmAddress
  ): Promise<BigNumber> {
    const [withdrawalInitiatedEvents, withdrawalFinalizedEvents] = await Promise.all([
      paginatedEventQuery(
        this.l2Bridge,
        this.l2Bridge.filters.ERC20BridgeInitiated(
          l2Token.toAddress(), // localToken
          null, // remoteToken
          fromAddress.toAddress() // from
        ),
        l2EventConfig
      ),
      paginatedEventQuery(
        this.l1Bridge,
        this.l1Bridge.filters.ERC20BridgeFinalized(
          null, // localToken
          l2Token.toAddress(), // remoteToken
          fromAddress.toAddress() // from
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

import {
  BigNumber,
  Contract,
  createFormatFunction,
  getNetworkName,
  Provider,
  Signer,
  EvmAddress,
  CHAIN_IDs,
  getTokenInfo,
  getRemoteTokenForL1Token,
} from "../../utils";
import { BinanceCEXBridge } from "./BinanceCEXBridge";
import WETH_ABI from "../../common/abi/Weth.json";
import { AugmentedTransaction } from "../../clients/TransactionClient";

export class BinanceCEXNativeBridge extends BinanceCEXBridge {
  private readonly wbnb: Contract;
  constructor(
    l2chainId: number,
    hubChainId: number,
    l2Signer: Signer,
    l1Provider: Provider | Signer,
    l1Token: EvmAddress
  ) {
    if (hubChainId !== CHAIN_IDs.MAINNET) {
      throw new Error("Cannot define a Binance CEX bridge for a non-production network");
    }
    super(l2chainId, hubChainId, l2Signer, l1Provider, l1Token);
    this.l1TokenInfo.symbol = "BNB";

    const l2TokenAddress = getRemoteTokenForL1Token(l1Token.toAddress(), l2chainId, { chainId: hubChainId });
    this.wbnb = new Contract(l2TokenAddress, WETH_ABI, l2Signer);
  }

  async constructWithdrawToL1Txns(
    toAddress: EvmAddress,
    l2Token: EvmAddress,
    _l1Token: EvmAddress,
    amount: BigNumber
  ): Promise<AugmentedTransaction[]> {
    const l2TokenInfo = getTokenInfo(l2Token.toAddress(), this.l2chainId);
    const depositAddress = await this.binanceApiClient.depositAddress({
      coin: this.l1TokenInfo.symbol,
      network: "BSC",
    });
    const formatter = createFormatFunction(2, 4, false, l2TokenInfo.decimals);
    const unwrapTxn: AugmentedTransaction = {
      contract: this.wbnb,
      chainId: this.l2chainId,
      method: "withdraw",
      args: [amount],
      nonMulticall: true,
      message: "🎰 Unwrapped WBNB on BSC before withdrawing to L1",
      mrkdwn: `Unwrapped ${formatter(amount.toString())} WBNB before withdrawing from ${getNetworkName(
        this.l2chainId
      )} to L1`,
    };
    const transferTxn: AugmentedTransaction = {
      contract: new Contract(depositAddress.address, WETH_ABI, this.l2Signer),
      chainId: this.l2chainId,
      method: "deposit",
      args: [],
      nonMulticall: true,
      canFailInSimulation: false,
      value: amount,
      message: `🎰 Withdrew BNB ${l2TokenInfo.symbol} to L1`,
      mrkdwn: `Withdrew ${formatter(amount.toString())} ${l2TokenInfo.symbol} from ${getNetworkName(
        this.l2chainId
      )} to L1`,
    };
    return [unwrapTxn, transferTxn];
  }
}

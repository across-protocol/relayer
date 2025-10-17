import {
  BigNumber,
  createFormatFunction,
  getNetworkName,
  Signer,
  Contract,
  EvmAddress,
  getTokenInfo,
} from "../../utils";
import { AugmentedTransaction } from "../../clients/TransactionClient";
import WETH_ABI from "../../common/abi/Weth.json";
import { BinanceCEXBridge } from "./";

export class BinanceCEXNativeBridge extends BinanceCEXBridge {
  constructor(l2chainId: number, hubChainId: number, l2Signer: Signer, l1Signer: Signer, l1Token: EvmAddress) {
    super(l2chainId, hubChainId, l2Signer, l1Signer, l1Token);
  }

  async constructWithdrawToL1Txns(
    _toAddress: EvmAddress,
    l2Token: EvmAddress,
    _l1Token: EvmAddress,
    amount: BigNumber
  ): Promise<AugmentedTransaction[]> {
    const weth = new Contract(l2Token.toNative(), WETH_ABI, this.l2Signer);
    const binanceApiClient = await this.getBinanceClient();
    const l2TokenInfo = getTokenInfo(l2Token, this.l2chainId);
    const depositAddress = await binanceApiClient.depositAddress({
      coin: this.l1TokenInfo.symbol,
      network: this.depositNetwork,
    });
    const formatter = createFormatFunction(2, 4, false, l2TokenInfo.decimals);
    const network = getNetworkName(this.l2chainId);
    const unwrapTxn: AugmentedTransaction = {
      contract: weth,
      chainId: this.l2chainId,
      method: "withdraw",
      args: [amount],
      nonMulticall: true,
      message: `🎰 Unwrapped WETH on ${network} before withdrawing to L1`,
      mrkdwn: `Unwrapped ${formatter(amount)} ${l2TokenInfo.symbol} before withdrawing from ${network} to L1`,
    };
    // Convert the deposit address into an ethers contract.
    const depositAddressContract = new Contract(depositAddress.address, [], this.l2Signer);
    const transferValueTxn: AugmentedTransaction = {
      contract: depositAddressContract,
      chainId: this.l2chainId,
      method: "",
      args: undefined,
      nonMulticall: true,
      canFailInSimulation: true, // This will fail in simulation since the relayer likely does not have enough ETH to perform the withdrawal before the unwrap step.
      value: amount,
      message: `🎰 Withdrew ${network} ${l2TokenInfo.symbol} to L1`,
      mrkdwn: `Withdrew ${formatter(amount.toString())} ${l2TokenInfo.symbol} from ${network} to L1`,
    };
    return [unwrapTxn, transferValueTxn];
  }
}

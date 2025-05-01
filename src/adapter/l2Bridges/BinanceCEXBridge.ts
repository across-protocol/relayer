import Binance from "binance-api-node";
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
  EvmAddress,
  getBinanceApiClient,
  getTranslatedTokenAddress,
  floatToBN,
  ethers,
  mapAsync,
  getTimestampForBlock,
} from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import ERC20_ABI from "../../common/abi/MinimalERC20.json";
import { AugmentedTransaction } from "../../clients/TransactionClient";

export class BinanceCEXBridge extends BaseL2BridgeAdapter {
  private readonly binanceApiClient;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l2Signer: Signer,
    l1Provider: Provider | Signer,
    l1Token: EvmAddress
  ) {
    super(l2chainId, hubChainId, l2Signer, l1Provider, l1Token);

    const l2Token = getTranslatedTokenAddress(l1Token.toAddress(), hubChainId, l2chainId);
    this.l2Bridge = new Contract(l2Token, ERC20_ABI, l2Signer);

    this.binanceApiClient = getBinanceApiClient(process.env["BINANCE_API_BASE"]);
  }

  constructWithdrawToL1Txns(
    toAddress: EvmAddress,
    l2Token: EvmAddress,
    _l1Token: EvmAddress,
    amount: BigNumber
  ): AugmentedTransaction[] {
    const l1TokenInfo = getL1TokenInfo(l2Token.toAddress(), this.l2chainId);
    /*
    const depositAddress = await this.binanceApiClient.depositAddress({
      coin: l1TokenInfo.symbol,
      network: "BNB",
    });
   */
    const formatter = createFormatFunction(2, 4, false, l1TokenInfo.decimals);
    const transferTxn: AugmentedTransaction = {
      contract: this.l2Bridge,
      chainId: this.l2chainId,
      method: "transfer",
      args: [
        toAddress.toAddress(), // depositAddress.address, // to
        amount, // amount
      ],
      nonMulticall: true,
      canFailInSimulation: false,
      value: bnZero,
      message: `🎰 Withdrew BNB ${l1TokenInfo.symbol} to L1`,
      mrkdwn: `Withdrew ${formatter(amount.toString())} ${l1TokenInfo.symbol} from ${getNetworkName(
        this.l2chainId
      )} to L1`,
    };
    return [transferTxn];
  }

  async getL2PendingWithdrawalAmount(
    l2EventConfig: EventSearchConfig,
    l1EventConfig: EventSearchConfig,
    fromAddress: EvmAddress,
    l2Token: EvmAddress
  ): Promise<BigNumber> {
    const l1TokenInfo = getL1TokenInfo(l2Token.toAddress(), this.l2chainId);
    const l1Provider =
      this.l1Provider instanceof ethers.providers.Provider
        ? (this.l1Provider as ethers.providers.Provider)
        : (this.l1Provider as ethers.Signer).provider;
    const fromTimestamp = (await getTimestampForBlock(this.l2Bridge.provider, l2EventConfig.fromBlock)) * 1_000;
    const [depositHistory, withdrawHistory] = await Promise.all([
      this.binanceApiClient.depositHistory({
        coin: l1TokenInfo.symbol,
        startTime: fromTimestamp,
      }),
      this.binanceApiClient.withdrawHistory({
        coin: l1TokenInfo.symbol,
        startTime: fromTimestamp,
        network: "ETH",
      }),
    ]);

    // Filter based on `fromAddress`.
    const [depositTxReceipts, withdrawTxReceipts] = await Promise.all([
      mapAsync(
        depositHistory.map((deposit) => deposit.txId),
        async (transactionHash) => this.l2Bridge.provider.getTransactionReceipt(transactionHash as string)
      ),
      mapAsync(
        withdrawHistory.map((withdraw) => withdraw.txId),
        async (transactionHash) => l1Provider.getTransactionReceipt(transactionHash as string)
      ),
    ]);

    // TODO: Decimals are incorrect.
    const totalDepositsInitiated = depositHistory.reduce(
      (sum, deposit) => sum.add(floatToBN(deposit.amount, l1TokenInfo.decimals)),
      bnZero
    );
    const totalWithdrawalsInitiated = withdrawHistory.reduce(
      (sum, withdrawal) => sum.add(floatToBN(withdrawal.amount, l1TokenInfo.decimals)),
      bnZero
    );
    const diff = totalDepositsInitiated.sub(totalWithdrawalsInitiated);
    return diff.gt(bnZero) ? diff : bnZero;
  }
}

import {
  BigNumber,
  bnZero,
  Contract,
  createFormatFunction,
  EventSearchConfig,
  getNetworkName,
  isDefined,
  Signer,
  EvmAddress,
  getBinanceApiClient,
  getTranslatedTokenAddress,
  floatToBN,
  getTimestampForBlock,
  CHAIN_IDs,
  getTokenInfo,
  compareAddressesSimple,
  getBinanceDeposits,
  getBinanceWithdrawals,
  BINANCE_NETWORKS,
  mapAsync,
} from "../../utils";
import { L1Token } from "../../interfaces";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import ERC20_ABI from "../../common/abi/MinimalERC20.json";
import { AugmentedTransaction } from "../../clients/TransactionClient";

export class BinanceCEXBridge extends BaseL2BridgeAdapter {
  // Store the promise to be evaluated when needed so that we can construct the bridge synchronously.
  protected readonly binanceApiClientPromise;
  protected binanceApiClient;
  // Store the token info for the bridge so we can reference the L1 decimals and L1 token symbol.
  protected l1TokenInfo: L1Token;
  // The deposit network corresponding to the L2.
  protected depositNetwork: string;

  constructor(l2chainId: number, hubChainId: number, l2Signer: Signer, l1Signer: Signer, l1Token: EvmAddress) {
    if (hubChainId !== CHAIN_IDs.MAINNET) {
      throw new Error("Cannot define a Binance CEX bridge for a non-production network");
    }
    super(l2chainId, hubChainId, l2Signer, l1Signer, l1Token);

    const l2Token = getTranslatedTokenAddress(l1Token, hubChainId, l2chainId);
    this.l2Bridge = new Contract(l2Token.toNative(), ERC20_ABI, l2Signer);
    const l1TokenInfo = getTokenInfo(l1Token, hubChainId);
    this.l1TokenInfo = {
      ...l1TokenInfo,
      address: l1Token,
      symbol: l1TokenInfo.symbol === "WETH" ? "ETH" : l1TokenInfo.symbol,
    };

    this.depositNetwork = BINANCE_NETWORKS[l2chainId];

    this.binanceApiClientPromise = getBinanceApiClient(process.env["BINANCE_API_BASE"]);
  }

  async constructWithdrawToL1Txns(
    _toAddress: EvmAddress,
    l2Token: EvmAddress,
    _l1Token: EvmAddress,
    amount: BigNumber
  ): Promise<AugmentedTransaction[]> {
    const binanceApiClient = await this.getBinanceClient();
    const l2TokenInfo = getTokenInfo(l2Token, this.l2chainId);
    const depositAddress = await binanceApiClient.depositAddress({
      coin: this.l1TokenInfo.symbol,
      network: this.depositNetwork,
    });
    const formatter = createFormatFunction(2, 4, false, l2TokenInfo.decimals);
    const transferTxn: AugmentedTransaction = {
      contract: this.l2Bridge,
      chainId: this.l2chainId,
      method: "transfer",
      args: [
        depositAddress.address, // to
        amount, // amount
      ],
      nonMulticall: true,
      canFailInSimulation: false,
      value: bnZero,
      message: `🎰 Withdrew BNB ${l2TokenInfo.symbol} to L1`,
      mrkdwn: `Withdrew ${formatter(amount.toString())} ${l2TokenInfo.symbol} from ${getNetworkName(
        this.l2chainId
      )} to L1`,
    };
    return [transferTxn];
  }

  async getL2PendingWithdrawalAmount(
    l2EventConfig: EventSearchConfig,
    _l1EventConfig: EventSearchConfig,
    fromAddress: EvmAddress,
    l2Token: EvmAddress
  ): Promise<BigNumber> {
    const binanceApiClient = await this.getBinanceClient();
    const l2TokenInfo = getTokenInfo(l2Token, this.l2chainId);
    const fromTimestamp = (await getTimestampForBlock(this.l2Bridge.provider, l2EventConfig.from)) * 1_000;
    const [_depositHistory, _withdrawHistory] = await Promise.all([
      getBinanceDeposits(binanceApiClient, fromTimestamp),
      getBinanceWithdrawals(binanceApiClient, this.l1TokenInfo.symbol, fromTimestamp),
    ]);
    const [depositHistory, withdrawHistory] = [
      _depositHistory.filter(
        (deposit) => deposit.network === this.depositNetwork && deposit.coin === this.l1TokenInfo.symbol
      ),
      _withdrawHistory.filter(
        (withdrawal) =>
          withdrawal.network === BINANCE_NETWORKS[CHAIN_IDs.MAINNET] &&
          compareAddressesSimple(withdrawal.recipient, fromAddress.toNative())
      ),
    ];

    // FilterMap to remove all deposits originating from other EOAs.
    const depositsInitiatedForAddress = (
      await mapAsync(depositHistory, async (deposit) => {
        const txnReceipt = await this.l2Signer.provider.getTransactionReceipt(deposit.txId);
        if (!compareAddressesSimple(txnReceipt.from, fromAddress.toNative())) {
          return undefined;
        }
        return deposit;
      })
    ).filter(isDefined);

    const totalDepositAmountForAddress = depositsInitiatedForAddress.reduce(
      (sum, deposit) => sum.add(floatToBN(deposit.amount, l2TokenInfo.decimals)),
      bnZero
    );
    const totalWithdrawalAmountForAddress = withdrawHistory.reduce(
      (sum, withdrawal) => sum.add(floatToBN(withdrawal.amount, l2TokenInfo.decimals)),
      bnZero
    );
    const diff = totalDepositAmountForAddress.sub(totalWithdrawalAmountForAddress);
    return diff.gt(bnZero) ? diff : bnZero;
  }

  protected async getBinanceClient() {
    return (this.binanceApiClient ??= await this.binanceApiClientPromise);
  }
}

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
  filterAsync,
  getBinanceDepositType,
  BinanceTransactionType,
  getBinanceWithdrawalType,
  getOutstandingBinanceDeposits,
  getRedisCache,
  getProvider,
  assert,
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
    // Remove any deposits and withdrawals that are marked as related to a swap.
    const depositHistory = await filterAsync(_depositHistory, async (deposit) => {
      const depositType = await getBinanceDepositType(deposit);
      return deposit.coin === this.l1TokenInfo.symbol && depositType !== BinanceTransactionType.SWAP;
    });
    const withdrawHistory = await filterAsync(_withdrawHistory, async (withdrawal) => {
      const withdrawalType = await getBinanceWithdrawalType(withdrawal);
      return (
        withdrawal.network === BINANCE_NETWORKS[CHAIN_IDs.MAINNET] &&
        compareAddressesSimple(withdrawal.recipient, fromAddress.toNative()) &&
        withdrawalType !== BinanceTransactionType.SWAP
      );
    });

    // FilterMap to remove all deposits originating from other EOAs.
    const redisCache = await getRedisCache();
    const depositsInitiatedForAddress = await filterAsync(depositHistory, async (deposit) => {
      // All withdrawals for the same coin should be withdrawn to the same address, so check the cache for the
      // withdrawal address for this chain before making a fresh RPC call.
      const binanceWithdrawalAddressKey = `binance-withdrawal-address:${deposit.coin}`;
      const binanceWithdrawalAddress = await redisCache.get<string>(binanceWithdrawalAddressKey);
      if (isDefined(binanceWithdrawalAddress)) {
        return compareAddressesSimple(binanceWithdrawalAddress, fromAddress.toNative());
      }

      // If the withdrawal address is not in the cache, make a fresh RPC call to get the withdrawal address.
      // @dev if deposit is for a different chain than this.l2Chain, then we need to use the provider for that chain to get the transaction receipt.
      const l2ChainId = Object.entries(BINANCE_NETWORKS).find(([, network]) => network === deposit.network)?.[0];
      assert(isDefined(l2ChainId), `Could not find chain ID for network ${deposit.network} in BINANCE_NETWORKS`);
      const l2ProviderForDepositChain =
        Number(l2ChainId) === this.l2chainId ? this.l2Signer.provider : await getProvider(Number(l2ChainId));
      const txnReceipt = await l2ProviderForDepositChain.getTransactionReceipt(deposit.txId);
      if (isDefined(txnReceipt)) {
        // The default caching TTL is 2 weeks which should be plenty assuming we don't change the EOA
        // address that we withdraw to frequently.
        await redisCache.set(binanceWithdrawalAddressKey, txnReceipt.from);
      }
      return compareAddressesSimple(txnReceipt?.from, fromAddress.toNative());
    });

    const unmatchedDeposits = getOutstandingBinanceDeposits(
      depositsInitiatedForAddress,
      withdrawHistory,
      this.depositNetwork
    );
    return unmatchedDeposits.reduce((sum, deposit) => sum.add(floatToBN(deposit.amount, l2TokenInfo.decimals)), bnZero);
  }

  protected async getBinanceClient() {
    return (this.binanceApiClient ??= await this.binanceApiClientPromise);
  }

  public pendingWithdrawalLookbackPeriodSeconds(): number {
    // Binance withdrawals are fast, we can shorten the lookback period to also reduce the number
    // of provider.getTransactionReceipt we have to make for each deposit event.
    return 1 * 60 * 60;
  }
}

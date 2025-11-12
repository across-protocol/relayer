import {
  Contract,
  BigNumber,
  EventSearchConfig,
  Signer,
  Provider,
  EvmAddress,
  getTokenInfo,
  assert,
  isDefined,
  getTimestampForBlock,
  getBinanceApiClient,
  floatToBN,
  CHAIN_IDs,
  compareAddressesSimple,
  isContractDeployedToAddress,
  winston,
  getBinanceDeposits,
  getBinanceWithdrawals,
  mapAsync,
  BINANCE_NETWORKS,
  ethers,
} from "../../utils";
import { BaseBridgeAdapter, BridgeTransactionDetails, BridgeEvents, BridgeEvent } from "../BaseBridgeAdapter";
import ERC20_ABI from "../../common/abi/MinimalERC20.json";

export class BinanceCEXBridge extends BaseBridgeAdapter<Signer, Signer | Provider> {
  // Only store the promise in the constructor and evaluate the promise in async blocks.
  protected readonly binanceApiClientPromise;
  protected binanceApiClient;
  protected tokenSymbol: string;
  protected l2Provider: Provider;

  constructor(
    dstChainId: number,
    srcChainId: number,
    srcSigner: Signer,
    dstSignerOrProvider: Signer | Provider,
    srcToken: EvmAddress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _logger: winston.Logger
  ) {
    if (srcChainId !== CHAIN_IDs.MAINNET) {
      throw new Error("Cannot define a binance CEX bridge on a non-production network");
    }
    // No L1 gateways needed since no L1 bridge transfers tokens from the EOA.
    super(dstChainId, srcChainId, srcSigner, dstSignerOrProvider, []);
    // Pull the binance API key from environment and throw if we cannot instantiate this bridge.
    this.binanceApiClientPromise = getBinanceApiClient(process.env["BINANCE_API_BASE"]);

    // Pass in the WETH ABI as the ERC20 ABI. This is fine to do since we only call `transfer` on `this.l1Bridge`.
    this.l1Bridge = new Contract(srcToken.toNative(), ERC20_ABI, srcSigner);

    // Get the required token/network context needed to query the Binance API.
    const _tokenSymbol = getTokenInfo(srcToken, this.srcChainId).symbol;
    // Handle the special case for when we are bridging WBNB to BNB on L2.
    this.tokenSymbol = _tokenSymbol === "WBNB" ? "BNB" : _tokenSymbol;

    // Cast the input Signer | Provider to a Provider.
    this.l2Provider = dstSignerOrProvider instanceof Signer ? dstSignerOrProvider.provider : dstSignerOrProvider;
  }

  async constructL1ToL2Txn(
    _toAddress: EvmAddress,
    srcToken: EvmAddress,
    _l2Token: EvmAddress,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    assert(srcToken.toNative() === this.getL1Bridge().address);
    // Fetch the deposit address from the binance API.

    const binanceApiClient = await this.getBinanceClient();

    const depositAddress = await binanceApiClient.depositAddress({
      coin: this.tokenSymbol,
      network: "ETH",
    });
    // Once we have the address, create a `transfer` of the token to that address.
    return {
      method: "transfer",
      args: [depositAddress.address, amount],
      contract: this.getL1Bridge(),
    };
  }

  async queryL1BridgeInitiationEvents(
    srcToken: EvmAddress,
    fromAddress: EvmAddress,
    _toAddress: EvmAddress,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // Since this is a CEX rebalancing adapter, it will never be used to rebalance contract funds. This means we can _always_ return an empty set
    // of bridge events if the monitored address is a contract on L1 or L2 and avoid querying the API needlessly.
    const isL1OrL2Contract = await this.isL1OrL2Contract(fromAddress);
    if (isL1OrL2Contract) {
      return {};
    }
    assert(srcToken.toNative() === this.getL1Bridge().address);
    const fromTimestamp = (await getTimestampForBlock(this.getL1Bridge().provider, eventConfig.from)) * 1_000; // Convert timestamp to ms.

    const binanceApiClient = await this.getBinanceClient();
    // Fetch the deposit address from the binance API.
    const _depositHistory = await getBinanceDeposits(binanceApiClient, fromTimestamp);

    // Only consider deposits which happened on L1.
    const depositHistory = _depositHistory.filter(
      (deposit) => deposit.network === BINANCE_NETWORKS[CHAIN_IDs.MAINNET] && deposit.coin === this.tokenSymbol
    );

    // FilterMap to remove all deposits which originated from another EOA.
    const { decimals: l1Decimals } = getTokenInfo(srcToken, this.srcChainId);
    const processedDeposits = await mapAsync(depositHistory, async (deposit) => {
      const txnReceipt = await this.getL1Bridge().provider.getTransactionReceipt(deposit.txId);
      if (!compareAddressesSimple(txnReceipt.from, fromAddress.toNative())) {
        return undefined;
      }
      return this.toBridgeEvent(floatToBN(deposit.amount, l1Decimals), txnReceipt);
    });

    return {
      [this.resolveL2TokenAddress(srcToken)]: processedDeposits.filter(isDefined),
    };
  }

  async queryL2BridgeFinalizationEvents(
    srcToken: EvmAddress,
    _fromAddress: EvmAddress,
    toAddress: EvmAddress,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // Since this is a CEX rebalancing adapter, it will never be used to rebalance contract funds. This means we can _always_ return an empty set
    // of bridge events if the monitored address is a contract on L1 or L2 and avoid querying the API needlessly.
    const isL1OrL2Contract = await this.isL1OrL2Contract(toAddress);
    if (isL1OrL2Contract) {
      return {};
    }
    // We must typecast the l2 signer or provider into specifically an ethers Provider type so we can call `getTransactionReceipt` and `getBlockByNumber` on it.
    assert(srcToken.toNative() === this.getL1Bridge().address);
    const fromTimestamp = (await getTimestampForBlock(this.l2Provider, eventConfig.from)) * 1_000; // Convert timestamp to ms.

    const binanceApiClient = await this.getBinanceClient();
    // Fetch the deposit address from the binance API.
    const _withdrawalHistory = await getBinanceWithdrawals(binanceApiClient, this.tokenSymbol, fromTimestamp);
    // Filter withdrawals based on whether their destination network was BSC.
    const withdrawalHistory = _withdrawalHistory.filter(
      (withdrawal) =>
        withdrawal.network === BINANCE_NETWORKS[CHAIN_IDs.BSC] &&
        compareAddressesSimple(withdrawal.recipient, toAddress.toNative())
    );
    const { decimals: l1Decimals } = getTokenInfo(srcToken, this.srcChainId);

    return {
      [this.resolveL2TokenAddress(srcToken)]: await mapAsync(withdrawalHistory, async (withdrawal) => {
        const txnReceipt = await this.l2Provider.getTransactionReceipt(withdrawal.txId);
        return this.toBridgeEvent(floatToBN(withdrawal.amount, l1Decimals), txnReceipt);
      }),
    };
  }

  private async isL1OrL2Contract(address: EvmAddress): Promise<boolean> {
    const [isL1Contract, isL2Contract] = await Promise.all([
      isContractDeployedToAddress(address.toNative(), this.srcSigner.provider),
      isContractDeployedToAddress(address.toNative(), this.l2Provider),
    ]);
    return isL1Contract || isL2Contract;
  }

  private toBridgeEvent(amount: BigNumber, receipt: ethers.providers.TransactionReceipt): BridgeEvent {
    return {
      amount,
      txnRef: receipt.transactionHash,
      txnIndex: receipt.transactionIndex,
      // @dev Since a binance deposit/withdrawal is just an ERC20 transfer, it will be the first log in the transaction. This log may not exist
      // if the transfer is with the native token.
      logIndex: receipt.logs[0]?.logIndex ?? 0,
      blockNumber: receipt.blockNumber,
    };
  }

  protected async getBinanceClient() {
    return (this.binanceApiClient ??= await this.binanceApiClientPromise);
  }
}

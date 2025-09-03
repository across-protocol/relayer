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
  mapAsync,
  getBinanceApiClient,
  floatToBN,
  CHAIN_IDs,
  compareAddressesSimple,
  isContractDeployedToAddress,
  winston,
} from "../../utils";
import { BaseBridgeAdapter, BridgeTransactionDetails, BridgeEvents } from "./BaseBridgeAdapter";
import ERC20_ABI from "../../common/abi/MinimalERC20.json";

export class BinanceCEXBridge extends BaseBridgeAdapter {
  // Only store the promise in the constructor and evaluate the promise in async blocks.
  protected readonly binanceApiClientPromise;
  protected binanceApiClient;
  protected tokenSymbol: string;
  protected l2Provider: Provider;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l1Token: EvmAddress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _logger: winston.Logger
  ) {
    if (hubChainId !== CHAIN_IDs.MAINNET) {
      throw new Error("Cannot define a binance CEX bridge on a non-production network");
    }
    // No L1 gateways needed since no L1 bridge transfers tokens from the EOA.
    super(l2chainId, hubChainId, l1Signer, []);
    // Pull the binance API key from environment and throw if we cannot instantiate this bridge.
    this.binanceApiClientPromise = getBinanceApiClient(process.env["BINANCE_API_BASE"]);

    // Pass in the WETH ABI as the ERC20 ABI. This is fine to do since we only call `transfer` on `this.l1Bridge`.
    this.l1Bridge = new Contract(l1Token.toNative(), ERC20_ABI, l1Signer);

    // Get the required token/network context needed to query the Binance API.
    const _tokenSymbol = getTokenInfo(l1Token, this.hubChainId).symbol;
    // Handle the special case for when we are bridging WBNB to BNB on L2.
    this.tokenSymbol = _tokenSymbol === "WBNB" ? "BNB" : _tokenSymbol;

    // Cast the input Signer | Provider to a Provider.
    this.l2Provider = l2SignerOrProvider instanceof Signer ? l2SignerOrProvider.provider : l2SignerOrProvider;
  }

  async constructL1ToL2Txn(
    _toAddress: EvmAddress,
    l1Token: EvmAddress,
    _l2Token: EvmAddress,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    assert(l1Token.toNative() === this.getL1Bridge().address);
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
    l1Token: EvmAddress,
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
    assert(l1Token.toNative() === this.getL1Bridge().address);
    const fromTimestamp = (await getTimestampForBlock(this.getL1Bridge().provider, eventConfig.from)) * 1_000; // Convert timestamp to ms.

    const binanceApiClient = await this.getBinanceClient();
    // Fetch the deposit address from the binance API.
    const _depositHistory = await binanceApiClient.depositHistory({
      coin: this.tokenSymbol,
      startTime: fromTimestamp,
    });
    // Only consider deposits which happened on L1.
    const depositHistory = _depositHistory.filter((deposit) => deposit.network === "ETH");
    const depositTxReceipts = await mapAsync(
      depositHistory.map((deposit) => deposit.txId),
      async (transactionHash) => this.getL1Bridge().provider.getTransactionReceipt(transactionHash as string)
    );
    // FilterMap to remove all deposits which originated from another EOA.
    const { decimals: l1Decimals } = getTokenInfo(l1Token, this.hubChainId);
    const processedDeposits = depositHistory
      .map((deposit, idx) => {
        if (!compareAddressesSimple(depositTxReceipts[idx].from, fromAddress.toNative())) {
          return undefined;
        }
        return {
          amount: floatToBN(deposit.amount, l1Decimals),
          txnRef: depositTxReceipts[idx].transactionHash,
          txnIndex: depositTxReceipts[idx].transactionIndex,
          // Only query the first log in the deposit event since a deposit corresponds to a single ERC20 `Transfer` event.
          // Alternatively, if this was a native token transfer, then there were no logs, so just assign 0. This should not
          // affect `sortEvents*` since the transaction index should be able to discriminate any two rebalances.
          logIndex: depositTxReceipts[idx].logs[0]?.logIndex ?? 0,
          blockNumber: depositTxReceipts[idx].blockNumber,
        };
      })
      .filter(isDefined);

    return {
      [this.resolveL2TokenAddress(l1Token)]: processedDeposits,
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: EvmAddress,
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
    assert(l1Token.toNative() === this.getL1Bridge().address);
    const fromTimestamp = (await getTimestampForBlock(this.l2Provider, eventConfig.from)) * 1_000; // Convert timestamp to ms.

    const binanceApiClient = await this.getBinanceClient();
    // Fetch the deposit address from the binance API.
    const _withdrawalHistory = await binanceApiClient.withdrawHistory({
      coin: this.tokenSymbol,
      startTime: fromTimestamp,
    });
    // Filter withdrawals based on whether their destination network was BSC.
    const withdrawalHistory = _withdrawalHistory.filter(
      (withdrawal) => withdrawal.network === "BSC" && compareAddressesSimple(withdrawal.address, toAddress.toNative())
    );
    const withdrawalTxReceipts = await mapAsync(
      withdrawalHistory.map((withdrawal) => withdrawal.txId as string),
      async (transactionHash) => this.l2Provider.getTransactionReceipt(transactionHash as string)
    );
    const { decimals: l1Decimals } = getTokenInfo(l1Token, this.hubChainId);

    return {
      [this.resolveL2TokenAddress(l1Token)]: withdrawalHistory.map((withdrawal, idx) => {
        return {
          amount: floatToBN(withdrawal.amount, l1Decimals),
          txnRef: withdrawalTxReceipts[idx].transactionHash,
          txnIndex: withdrawalTxReceipts[idx].transactionIndex,
          // Same as resolving initiation events. Only query the first log since it is just an ERC20 `Transfer` call.
          // Alternatively, if this was a native token transfer, then there were no logs, so just assign 0. This should not
          // affect `sortEvents*` since the transaction index should be able to discriminate any two rebalances.
          logIndex: withdrawalTxReceipts[idx].logs[0]?.logIndex ?? 0,
          blockNumber: withdrawalTxReceipts[idx].blockNumber,
        };
      }),
    };
  }

  private async isL1OrL2Contract(address: EvmAddress): Promise<boolean> {
    const [isL1Contract, isL2Contract] = await Promise.all([
      isContractDeployedToAddress(address.toNative(), this.l1Signer.provider),
      isContractDeployedToAddress(address.toNative(), this.l2Provider),
    ]);
    return isL1Contract || isL2Contract;
  }

  protected async getBinanceClient() {
    return (this.binanceApiClient ??= await this.binanceApiClientPromise);
  }
}

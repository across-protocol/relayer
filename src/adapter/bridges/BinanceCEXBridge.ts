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
  floatToBN,
  CHAIN_IDs,
  compareAddressesSimple,
  isContractDeployedToAddress,
  winston,
  mapAsync,
  BINANCE_NETWORKS,
  ethers,
  filterAsync,
  getBinanceDepositType,
  BinanceTransactionType,
  getBinanceWithdrawalType,
  isCompletedBinanceWithdrawal,
  toAddressType,
} from "../../utils";
import { BinanceClient } from "../../clients";
import { BaseBridgeAdapter, BridgeTransactionDetails, BridgeEvents, BridgeEvent } from "./BaseBridgeAdapter";
import ERC20_ABI from "../../common/abi/MinimalERC20.json";

export class BinanceCEXBridge extends BaseBridgeAdapter {
  // Only store the promise in the constructor and evaluate the promise in async blocks.
  protected readonly binanceClientPromise;
  protected binanceClient: BinanceClient | undefined;
  protected tokenSymbol: string;
  protected l2Provider: Provider;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l1Token: EvmAddress,
    logger: winston.Logger
  ) {
    if (hubChainId !== CHAIN_IDs.MAINNET) {
      throw new Error("Cannot define a binance CEX bridge on a non-production network");
    }
    // No L1 gateways needed since no L1 bridge transfers tokens from the EOA.
    super(l2chainId, hubChainId, l1Signer, []);
    // Pull the binance API key from environment and throw if we cannot instantiate this bridge.
    this.binanceClientPromise = BinanceClient.create({ logger, url: process.env.BINANCE_API_BASE });

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

    const binanceClient = await this.getBinanceClient();

    const depositAddress = await binanceClient.getDepositAddress({
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

    const binanceClient = await this.getBinanceClient();
    // Fetch the deposit address from the binance API.
    const _depositHistory = await binanceClient.getDeposits(fromTimestamp);

    // Remove any binance deposits that are marked as related to a swap, or were not sent on L1.
    const depositHistory = await filterAsync(_depositHistory, async (deposit) => {
      const depositType = await getBinanceDepositType(deposit);
      return (
        deposit.network === BINANCE_NETWORKS[CHAIN_IDs.MAINNET] &&
        deposit.coin === this.tokenSymbol &&
        depositType !== BinanceTransactionType.SWAP
      );
    });

    // FilterMap to remove all deposits which originated from another EOA.
    const { decimals: l1Decimals } = getTokenInfo(l1Token, this.hubChainId);
    const processedDeposits = await mapAsync(depositHistory, async (deposit) => {
      const txnReceipt = await this.getL1Bridge().provider.getTransactionReceipt(deposit.txId);
      if (!compareAddressesSimple(txnReceipt.from, fromAddress.toNative())) {
        return undefined;
      }
      return this.toBridgeEvent(floatToBN(deposit.amount, l1Decimals), txnReceipt);
    });

    return {
      [this.resolveL2TokenAddress(l1Token)]: processedDeposits.filter(isDefined),
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

    const binanceClient = await this.getBinanceClient();
    // Fetch the deposit address from the binance API.
    const _withdrawalHistory = await binanceClient.getWithdrawals(this.tokenSymbol, fromTimestamp);
    // Filter withdrawals based on whether their destination network was BSC and those associated with a swap rebalance.
    const withdrawalHistory = await filterAsync(_withdrawalHistory, async (withdrawal) => {
      const withdrawalType = await getBinanceWithdrawalType(withdrawal);
      return (
        isCompletedBinanceWithdrawal(withdrawal.status) &&
        withdrawal.network === BINANCE_NETWORKS[CHAIN_IDs.BSC] &&
        compareAddressesSimple(withdrawal.recipient, toAddress.toNative()) &&
        withdrawalType !== BinanceTransactionType.SWAP
      );
    });
    const l2TokenAddress = this.resolveL2TokenAddress(l1Token);
    const { decimals: l2Decimals } = getTokenInfo(toAddressType(l2TokenAddress, this.l2chainId), this.l2chainId);

    return {
      [l2TokenAddress]: await mapAsync(withdrawalHistory, async (withdrawal) => {
        const txnReceipt = await this.l2Provider.getTransactionReceipt(withdrawal.txId);
        return this.toBridgeEvent(floatToBN(withdrawal.amount, l2Decimals), txnReceipt);
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

  protected async getBinanceClient(): Promise<BinanceClient> {
    return (this.binanceClient ??= await this.binanceClientPromise);
  }
}

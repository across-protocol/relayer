import {
  BigNumber,
  bnZero,
  Contract,
  createFormatFunction,
  EventSearchConfig,
  getNetworkName,
  Signer,
  EvmAddress,
  BinanceApi,
  getBinanceApiClient,
  getBinanceDepositAddress,
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
  isCompletedBinanceWithdrawal,
  isTerminalFailedBinanceDeposit,
  getOutstandingBinanceDeposits,
  isDefined,
  paginatedEventQuery,
  BinanceDeposit,
} from "../../utils";
import { L1Token } from "../../interfaces";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import ERC20_ABI from "../../common/abi/MinimalERC20.json";
import { AugmentedTransaction } from "../../clients/TransactionClient";

export class BinanceCEXBridge extends BaseL2BridgeAdapter {
  // Store the promise to be evaluated when needed so that we can construct the bridge synchronously.
  protected readonly binanceApiClientPromise;
  protected binanceApiClient: BinanceApi | undefined;
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
    if (!isDefined(this.depositNetwork)) {
      throw new Error(`No Binance network configured for chain ${l2chainId}`);
    }

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
    const depositAddress = await getBinanceDepositAddress(binanceApiClient, {
      coin: this.l1TokenInfo.symbol,
      network: this.depositNetwork,
    });
    const formatter = createFormatFunction(2, 4, false, l2TokenInfo.decimals);
    const network = getNetworkName(this.l2chainId);
    const transferTxn: AugmentedTransaction = {
      contract: this.getL2Bridge(),
      chainId: this.l2chainId,
      method: "transfer",
      args: [
        depositAddress.address, // to
        amount, // amount
      ],
      nonMulticall: true,
      canFailInSimulation: false,
      value: bnZero,
      message: `🎰 Withdrew ${network} ${l2TokenInfo.symbol} to L1 via Binance`,
      mrkdwn: `Withdrew ${formatter(amount.toString())} ${l2TokenInfo.symbol} from ${network} to L1 via Binance`,
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
    const fromTimestamp = (await getTimestampForBlock(this.getL2Bridge().provider, l2EventConfig.from)) * 1_000;
    const [_depositHistory, _withdrawHistory] = await Promise.all([
      getBinanceDeposits(binanceApiClient, fromTimestamp),
      getBinanceWithdrawals(binanceApiClient, this.l1TokenInfo.symbol, fromTimestamp),
    ]);
    // Remove any deposits and withdrawals that are marked as related to a swap. Deposits in a terminal failure
    // state are also dropped: Binance will never credit them, so they will never be withdrawn to L1, and counting
    // them as pending L2 -> L1 capital would inflate the hub's virtual balance and suppress rebalances we need.
    // The finalizer applies the same reasoning when it picks finalizable deposits.
    const depositHistory = await filterAsync(_depositHistory, async (deposit) => {
      const depositType = await getBinanceDepositType(deposit);
      return (
        deposit.network === this.depositNetwork &&
        deposit.coin === this.l1TokenInfo.symbol &&
        !isTerminalFailedBinanceDeposit(deposit.status) &&
        depositType !== BinanceTransactionType.SWAP
      );
    });
    const withdrawHistory = await filterAsync(_withdrawHistory, async (withdrawal) => {
      const withdrawalType = await getBinanceWithdrawalType(withdrawal);
      return (
        isCompletedBinanceWithdrawal(withdrawal.status) &&
        withdrawal.network === BINANCE_NETWORKS[CHAIN_IDs.MAINNET] &&
        compareAddressesSimple(withdrawal.recipient, fromAddress.toNative()) &&
        withdrawalType !== BinanceTransactionType.SWAP
      );
    });

    // Remove all deposits from this L2 which originated from another EOA.
    const filteredDepositHistory = await this.filterDepositsFromAddress(depositHistory, fromAddress, l2EventConfig);

    const unmatchedDeposits = getOutstandingBinanceDeposits(
      filteredDepositHistory,
      withdrawHistory,
      this.depositNetwork
    );
    return unmatchedDeposits.reduce((sum, deposit) => sum.add(floatToBN(deposit.amount, l2TokenInfo.decimals)), bnZero);
  }

  /**
   * Narrows Binance's deposit history to the deposits this relayer funded. The Binance account is shared, so a
   * deposit on this network/coin is not necessarily ours.
   * @dev One Transfer query covers the whole search window in a single (paginated) getLogs, so the cost is flat in
   * the number of deposits. Reading `receipt.from` per deposit instead costs one getTransactionReceipt each and
   * scales with deposit volume, which on a busy network is paid on every inventory refresh.
   * @dev ERC20 deposits only — native-token transfers emit no Transfer event. BinanceCEXNativeBridge overrides this.
   */
  protected async filterDepositsFromAddress(
    deposits: BinanceDeposit[],
    fromAddress: EvmAddress,
    l2EventConfig: EventSearchConfig
  ): Promise<BinanceDeposit[]> {
    if (deposits.length === 0) {
      return [];
    }
    const binanceApiClient = await this.getBinanceClient();
    const depositAddress = await getBinanceDepositAddress(binanceApiClient, {
      coin: this.l1TokenInfo.symbol,
      network: this.depositNetwork,
    });
    const l2Bridge = this.getL2Bridge();
    const transfers = await paginatedEventQuery(
      l2Bridge,
      l2Bridge.filters.Transfer(fromAddress.toNative(), depositAddress.address),
      l2EventConfig
    );
    const fundedTxnRefs = new Set(transfers.map(({ transactionHash }) => transactionHash.toLowerCase()));
    return deposits.filter((deposit) => fundedTxnRefs.has(deposit.txId.toLowerCase()));
  }

  protected async getBinanceClient() {
    return (this.binanceApiClient ??= await this.binanceApiClientPromise);
  }

  public pendingWithdrawalLookbackPeriodSeconds(): number {
    // The Binance withdrawal itself is fast, but it can only be requested once Binance finishes confirming the
    // L2 deposit, and that dominates the round trip. Measured deposit -> withdrawable on ZKSYNCERA USDC: 34, 54
    // and 69 minutes across three deposits (2026-08-03 and 2026-08-07). A 1 hour lookback dropped in-flight
    // deposits out of the pending total before Binance released them, so the relayer stopped counting capital it
    // still owned. 4 hours keeps them visible with headroom. Widening is cheap now that filterDepositsFromAddress
    // attributes deposits with one getLogs over the whole window rather than a receipt per deposit: the extra cost
    // is a wider block range on that single query. BinanceCEXNativeBridge still pays a receipt per deposit, but its
    // deposit volume is low.
    return 4 * 60 * 60;
  }
}

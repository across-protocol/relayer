import { type Binance } from "binance-api-node";
import { SUPPORTED_TOKENS } from "../../common";
import {
  winston,
  Signer,
  getTimestampForBlock,
  mapAsync,
  getBinanceApiClient,
  TOKEN_SYMBOLS_MAP,
  compareAddressesSimple,
  formatUnits,
  floatToBN,
  bnZero,
  getTokenInfo,
  ethers,
  groupObjectCountsByProp,
} from "../../utils";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { FinalizerPromise } from "../types";

// Alias for a Binance deposit/withdrawal status.
enum Status {
  Confirmed = 1,
  Pending = 0,
  Rejected = 2,
  Credited = 6,
  WrongDeposit = 7,
  WaitingUserConfirm = 8,
}

// Alias for Binance network symbols.
enum DepositNetwork {
  Ethereum = "ETH",
  BSC = "BSC",
}

// A Coin contains balance data and network information (such as withdrawal limits, extra information about the network, etc.) for a specific
// token.
type Coin = {
  symbol: string;
  balance: string;
  networkList: Network[];
};

// Network represents basic information corresponding to a Binance supported deposit/withdrawal network. It is always associated with a coin.
type Network = {
  name: string;
  coin: string;
  withdrawMin: string;
  withdrawMax: string;
  contractAddress: string;
};

// A BinanceInteraction is either a deposit or withdrawal into/from a Binance hot wallet.
type BinanceInteraction = {
  // The amount of `coin` transferred in this interaction.
  amount: number;
  // The external (non binance-wallet) EOA involved with this interaction.
  externalAddress: string;
  // The coin used in this interaction (i.e. the token symbol).
  coin: string;
  // The network on which this interaction took place.
  network: string;
  // The status of the deposit/withdrawal.
  status?: number;
};

// ParsedAccountCoins represents a simplified return type of the Binance `accountCoins` endpoint.
type ParsedAccountCoins = Coin[];

/**
 * Unlike other finalizers, the Binance finalizer is only used to withdraw EOA deposits on Binance.
 * This means we need to be cautious on the addresses to finalize, as a "finalization" is essentially a withdrawal
 * from a Binance hot wallet.
 */
export async function binanceFinalizer(
  logger: winston.Logger,
  hubSigner: Signer,
  _hubPoolClient: HubPoolClient,
  l2SpokePoolClient: SpokePoolClient,
  l1SpokePoolClient: SpokePoolClient,
  senderAddresses: string[]
): Promise<FinalizerPromise> {
  const chainId = l2SpokePoolClient.chainId;
  const hubChainId = l1SpokePoolClient.chainId;
  const l1EventSearchConfig = l1SpokePoolClient.eventSearchConfig;

  const [binanceApi, _fromTimestamp] = await Promise.all([
    getBinanceApiClient(process.env["BINANCE_API_BASE"]),
    getTimestampForBlock(hubSigner.provider, l1EventSearchConfig.fromBlock),
  ]);
  const fromTimestamp = _fromTimestamp * 1_000;

  const [_binanceDeposits, accountCoins] = await Promise.all([
    getBinanceDeposits(binanceApi, hubSigner.provider, l2SpokePoolClient.spokePool.provider, fromTimestamp),
    getAccountCoins(binanceApi),
  ]);

  const statusesGrouped = groupObjectCountsByProp(_binanceDeposits, (deposit: { status: number }) => {
    switch (deposit.status) {
      case Status.Confirmed:
        return "ready-to-finalize";
      case Status.Rejected:
        return "deposit-rejected";
      case Status.WrongDeposit:
        return "wrong-deposit";
      default:
        return "waiting-to-finalize";
    }
  });
  logger.debug({
    at: "BinanceFinalizer",
    message: `Found ${_binanceDeposits.length} historical Binance deposits.`,
    statusesGrouped,
    fromTimestamp: fromTimestamp,
  });
  const binanceDeposits = _binanceDeposits.filter((deposit) => deposit.status === Status.Confirmed);

  await mapAsync(senderAddresses, async (address) => {
    // Filter our list of deposits by the withdrawal address. We will only finalize deposits when the depositor EOA is in `senderAddresses`.
    // For deposits specifically, the `externalAddress` field will always be an EOA since it corresponds to the tx.origin of the deposit transaction.
    const depositsInScope = binanceDeposits.filter((deposit) =>
      compareAddressesSimple(deposit.externalAddress, address)
    );
    if (depositsInScope.length === 0) {
      logger.debug({
        at: "BinanceFinalizer",
        message: `No finalizable deposits found for ${address}`,
      });
      return;
    }

    // The inner loop finalizes all deposits for all supported tokens for the address.
    await mapAsync(SUPPORTED_TOKENS[chainId], async (_symbol) => {
      // For both finalizers, we need to re-map WBNB -> BNB and re-map WETH -> ETH.
      let symbol = _symbol === "WETH" ? "ETH" : _symbol;
      symbol = symbol === "WBNB" ? "BNB" : symbol;

      const coin = accountCoins.find((coin) => coin.symbol === symbol);
      const l1Token = TOKEN_SYMBOLS_MAP[symbol].addresses[hubChainId];
      const { decimals: l1Decimals } = getTokenInfo(l1Token, hubChainId);
      const withdrawals = await getBinanceWithdrawals(binanceApi, symbol, fromTimestamp);

      // Start by finalizing L1 -> L2, then go to L2 -> L1.
      await mapAsync([DepositNetwork.Ethereum, DepositNetwork.BSC], async (depositNetwork) => {
        const withdrawNetwork =
          depositNetwork === DepositNetwork.Ethereum ? DepositNetwork.BSC : DepositNetwork.Ethereum;
        const networkLimits = coin.networkList.find((network) => network.name === withdrawNetwork);
        // Get both the amount deposited and ready to be finalized and the amount already withdrawn on L2.
        const depositAmounts = depositsInScope
          .filter((deposit) => deposit.coin === symbol && deposit.network === depositNetwork)
          .reduce((sum, deposit) => sum.add(floatToBN(deposit.amount, l1Decimals)), bnZero);

        const withdrawalsInScope = withdrawals.filter(
          (withdrawal) =>
            compareAddressesSimple(withdrawal.externalAddress, address) && withdrawal.network === withdrawNetwork
        );
        const withdrawalAmounts = withdrawalsInScope.reduce(
          (sum, deposit) => sum.add(floatToBN(deposit.amount, l1Decimals)),
          bnZero
        );

        // The amount we are able to finalize is `depositAmounts - withdrawalAmounts`. It is possible for `depositAmounts` to be less than `withdrawalAmounts` if there is a gap between
        // the lookback windows used to query deposits and withdrawals, so we require this value to be > bnZero.
        const _amountToFinalize = depositAmounts.sub(withdrawalAmounts);
        let amountToFinalize = _amountToFinalize.gt(bnZero) ? Number(formatUnits(_amountToFinalize, l1Decimals)) : 0;

        logger.debug({
          at: "BinanceFinalizer",
          message: `(${depositNetwork} -> ${withdrawNetwork}) ${symbol} withdrawals for ${address}.`,
          totalDepositedAmount: formatUnits(depositAmounts, l1Decimals),
          withdrawalAmount: formatUnits(withdrawalAmounts, l1Decimals),
          amountToFinalize,
        });
        // Additionally, binance imposes a minimum amount to withdraw. If the amount we want to finalize is less than the minimum, then
        // do not attempt to withdraw anything. Likewise, if the amount we want to withdraw is greater than the maximum, then warn and withdraw the maximum amount.
        if (amountToFinalize >= Number(networkLimits.withdrawMax)) {
          logger.warn({
            at: "BinanceFinalizer",
            message: `(${depositNetwork} -> ${withdrawNetwork}) Cannot withdraw total amount ${amountToFinalize} ${symbol} since it is above the network limit ${networkLimits.withdrawMax}. Withdrawing the maximum amount instead.`,
          });
          amountToFinalize = Number(networkLimits.withdrawMax);
        }
        // Binance also takes fees from withdrawals. Since we are bundling together multiple deposits, it is possible that the amount we are trying to withdraw is slightly greater than our free balance
        // (since a prior withdrawal's fees were paid for in part from the current withdrawal's balance). In this case, set `amountToFinalize` as `min(amountToFinalize, accountBalance)`.
        if (amountToFinalize > Number(coin.balance)) {
          logger.debug({
            at: "BinanceFinalizer",
            message: `(${depositNetwork} -> ${withdrawNetwork}) Need to reduce the amount to finalize since hot wallet balance is less than desired withdrawal amount.`,
            amountToFinalize,
            balance: coin.balance,
          });
          amountToFinalize = Number(coin.balance);
        }
        if (amountToFinalize >= Number(networkLimits.withdrawMin)) {
          const withdrawalId = await binanceApi.withdraw({
            coin: symbol,
            address,
            network: withdrawNetwork,
            amount: amountToFinalize,
            transactionFeeFlag: false,
          });
          logger.info({
            at: "BinanceFinalizer",
            message: `(${depositNetwork} -> ${withdrawNetwork}) Finalized deposit on ${withdrawNetwork} for ${amountToFinalize} ${symbol}.`,
            amount: amountToFinalize,
            withdrawalId,
          });
        } else {
          logger.debug({
            at: "BinanceFinalizer",
            message: `(${depositNetwork} -> ${withdrawNetwork}) ${amountToFinalize} is less than minimum withdrawable amount ${networkLimits.withdrawMin} for token ${symbol}.`,
          });
        }
      });
    });
  });
  return {
    callData: [],
    crossChainMessages: [],
  };
}

// Gets all binance deposits for the Binance account starting from `startTime`-present.
async function getBinanceDeposits(
  binanceApi: Binance,
  l1Provider: ethers.providers.Provider,
  l2Provider: ethers.providers.Provider,
  startTime: number
): Promise<BinanceInteraction[]> {
  const _depositHistory = await binanceApi.depositHistory({ startTime });
  const depositHistory = Object.values(_depositHistory);

  return mapAsync(depositHistory, async (deposit) => {
    const provider = deposit.network === DepositNetwork.Ethereum ? l1Provider : l2Provider;
    const depositTxnReceipt = await provider.getTransactionReceipt(deposit.txId);
    return {
      amount: Number(deposit.amount),
      externalAddress: depositTxnReceipt.from,
      coin: deposit.coin,
      network: deposit.network,
      status: deposit.status,
    };
  });
}

// Gets all Binance withdrawals of a specific coin starting from `startTime`-present.
async function getBinanceWithdrawals(
  binanceApi: Binance,
  coin: string,
  startTime: number
): Promise<BinanceInteraction[]> {
  const withdrawals = await binanceApi.withdrawHistory({ coin, startTime });

  return Object.values(withdrawals).map((withdrawal) => {
    return {
      amount: Number(withdrawal.amount),
      externalAddress: withdrawal.address,
      coin,
      network: withdrawal.network,
      status: withdrawal.status,
    };
  });
}

// The call to accountCoins returns an opaque `unknown` object with extraneous information. This function
// parses the unknown into a readable object to be used by the finalizers.
async function getAccountCoins(binanceApi: Binance): Promise<ParsedAccountCoins> {
  const coins = Object.values(await binanceApi["accountCoins"]());
  return coins.map((coin) => {
    const networkList = coin["networkList"]?.map((network) => {
      return {
        name: network["network"],
        coin: network["coin"],
        withdrawMin: network["withdrawMin"],
        withdrawMax: network["withdrawMax"],
        contractAddress: network["contractAddress"],
      } as Network;
    });
    return {
      symbol: coin["coin"],
      balance: coin["free"],
      networkList,
    } as Coin;
  });
}

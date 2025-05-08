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
} from "../../utils";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { FinalizerPromise } from "../types";

type Coin = {
  symbol: string;
  balance: string;
  networkList: Network[];
};

type Network = {
  name: string;
  coin: string;
  withdrawMin: string;
  withdrawMax: string;
  contractAddress: string;
};

type BinanceInteraction = {
  // The amount of `coin` transferred in this interaction.
  amount: number;
  // The external (non binance-wallet) EOA involved with this interaction.
  externalAddress: string;
  // The coin used in this interaction (i.e. the token symbol).
  coin: string;
  // The network on which this interaction took place.
  network: string;
};

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

  const binanceApi = await getBinanceApiClient(process.env["BINANCE_API_BASE"]);
  const fromTimestamp = (await getTimestampForBlock(hubSigner.provider, l1EventSearchConfig.fromBlock)) * 1_000;

  const [binanceDeposits, accountCoins] = await Promise.all([
    getBinanceDeposits(binanceApi, hubSigner.provider, fromTimestamp),
    await getAccountCoins(binanceApi),
  ]);

  logger.debug({
    at: "BinanceFinalizer",
    message: `Found ${binanceDeposits.length} historical deposits with status === 1.`,
    fromTimestamp: fromTimestamp / 1_000,
  });

  await mapAsync(senderAddresses, async (address) => {
    // Filter our list of deposits by the withdrawal address. We will only finalize deposits when the depositor EOA is in `senderAddresses`.
    const depositsInScope = binanceDeposits.filter((deposit) =>
      compareAddressesSimple(deposit.externalAddress, address)
    );
    if (depositsInScope.length === 0) {
      logger.debug({
        at: "BinanceFinalizer",
        message: `No finalizable deposits found for ${address}`,
        fromTimestamp: fromTimestamp / 1_000,
      });
      return;
    }

    // The inner loop finalizes all deposits for all supported tokens for the address.
    await mapAsync(SUPPORTED_TOKENS[chainId], async (_symbol) => {
      // For the l1 to l2 finalizer, we need to re-map WBNB -> BNB and re-map WETH -> ETH.
      const symbol = _symbol[0] === "W" ? _symbol.slice(1) : _symbol;

      const coin = accountCoins.find((coin) => coin.symbol === symbol);
      const l1Token = TOKEN_SYMBOLS_MAP[symbol].addresses[hubChainId];
      const { decimals: l1Decimals } = getTokenInfo(l1Token, hubChainId);
      const withdrawals = await getBinanceWithdrawals(binanceApi, symbol, fromTimestamp);

      // Start by finalizing L1 -> L2, then go to L2 -> L1.
      await mapAsync(["ETH", "BSC"], async (depositNetwork) => {
        const withdrawNetwork = depositNetwork === "ETH" ? "BSC" : "ETH";
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
  provider: ethers.providers.Provider,
  startTime: number
): Promise<BinanceInteraction[]> {
  const _depositHistory = await binanceApi.depositHistory({ startTime });

  // We need to filter out deposits which are not ready to be finalized. A deposit.status of 1 means that the deposit has been fully processed and can be withdrawn on L1/L2.
  const depositHistory = Object.values(_depositHistory).filter((deposit) => deposit.status === 1);

  return mapAsync(depositHistory, async (deposit) => {
    const depositTxnReceipt = await provider.getTransactionReceipt(deposit.txId);
    return {
      amount: Number(deposit.amount),
      externalAddress: depositTxnReceipt.from,
      coin: deposit.coin,
      network: deposit.network,
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

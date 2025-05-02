import { SUPPORTED_TOKENS } from "../../../common";
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
} from "../../../utils";
import { getAccountCoins, getBinanceDepositsByNetwork, getBinanceWithdrawalsByNetwork } from "./common";
import { HubPoolClient, SpokePoolClient } from "../../../clients";
import { FinalizerPromise } from "../../types";

/**
 * Unlike other finalizers, the Binance finalizer is only used to withdraw EOA deposits on Ethereum.
 * This means we need to be cautious on the addresses to finalize, as a "finalization" is essentially a withdrawal
 * from a Binance hot wallet.
 */
export async function binanceL2ToL1Finalizer(
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

  const binanceApi = getBinanceApiClient(process.env["BINANCE_API_BASE"]);
  const fromTimestamp = (await getTimestampForBlock(hubSigner.provider, l1EventSearchConfig.fromBlock)) * 1_000;

  const [binanceDeposits, accountCoins] = await Promise.all([
    getBinanceDepositsByNetwork(binanceApi, l2SpokePoolClient.spokePool.provider, "BSC", fromTimestamp),
    await getAccountCoins(binanceApi),
  ]);

  logger.debug({
    at: "BinanceL2ToL1Finalizer",
    message: `Found ${binanceDeposits.length} historical L1 deposits with status === 1 on Binance Smart Chain.`,
    fromTimestamp: fromTimestamp / 1_000,
  });

  await mapAsync(senderAddresses, async (address) => {
    // Filter our list of deposits by the withdrawal address. We will only finalize deposits when the depositor EOA is in `senderAddresses`.
    const depositsInScope = binanceDeposits.filter((deposit) =>
      compareAddressesSimple(deposit.externalAddress, address)
    );
    if (depositsInScope.length === 0) {
      logger.debug({
        at: "BinanceL2ToL1Finalizer",
        message: `No finalizable deposits found for ${address}`,
        fromTimestamp: fromTimestamp / 1_000,
      });
      return;
    }

    // The inner loop finalizes all deposits for all supported tokens for the address.
    await mapAsync(SUPPORTED_TOKENS[chainId], async (symbol) => {
      const coin = accountCoins.find((coin) => coin.symbol === symbol);
      const networkLimits = coin.networkList.find((network) => network.name === "ETH");
      const l1Token = TOKEN_SYMBOLS_MAP[symbol].addresses[hubChainId];
      const { decimals: l1Decimals } = getTokenInfo(l1Token, hubChainId);

      // Get both the amount deposited and ready to be finalized and the amount already withdrawn on L2.
      const depositAmounts = depositsInScope
        .filter((deposit) => deposit.coin === symbol)
        .reduce((sum, deposit) => sum.add(floatToBN(deposit.amount, l1Decimals)), bnZero);
      const withdrawals = await getBinanceWithdrawalsByNetwork(binanceApi, "ETH", symbol, fromTimestamp);
      const withdrawalsInScope = withdrawals.filter((withdrawal) =>
        compareAddressesSimple(withdrawal.externalAddress, address)
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
        at: "BinanceL2ToL1Finalizer",
        message: `${symbol} withdrawals for ${address}`,
        totalDepositedAmount: formatUnits(depositAmounts, l1Decimals),
        withdrawalAmount: formatUnits(withdrawalAmounts, l1Decimals),
        amountToFinalize,
      });
      // Additionally, binance imposes a minimum amount to withdraw. If the amount we want to finalize is less than the minimum, then
      // do not attempt to withdraw anything. Likewise, if the amount we want to withdraw is greater than the maximum, then warn and withdraw the maximum amount.
      if (amountToFinalize >= Number(networkLimits.withdrawMax)) {
        logger.warn({
          at: "BinanceL2ToL1Finalizer",
          message: `Cannot withdraw total amount ${amountToFinalize} ${symbol} since it is above the network limit ${networkLimits.withdrawMax}. Withdrawing the maximum amount instead.`,
        });
        amountToFinalize = Number(networkLimits.withdrawMax);
      }
      if (amountToFinalize >= Number(networkLimits.withdrawMin)) {
        const withdrawalId = await binanceApi.withdraw({
          coin: symbol,
          address,
          network: "ETH",
          amount: amountToFinalize,
          transactionFeeFlag: false,
        });
        logger.info({
          at: "BinanceL2ToL1Finalizer",
          message: `Finalized deposit on ETH for ${amountToFinalize} ${symbol}`,
          amount: amountToFinalize,
          withdrawalId,
        });
      } else {
        logger.debug({
          at: "BinanceL2ToL1Finalizer",
          message: `${amountToFinalize} is less than minimum withdrawable amount ${networkLimits.withdrawMin} for token ${symbol}`,
        });
      }
    });
  });
  return Promise.resolve({
    callData: [],
    crossChainMessages: [],
  });
}

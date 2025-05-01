import { SUPPORTED_TOKENS } from "../../../common";
import {
  winston,
  Signer,
  getTimestampForBlock,
  mapAsync,
  getBinanceApiClient,
  TOKEN_SYMBOLS_MAP,
  compareAddressesSimple,
  filterAsync,
  formatUnits,
  floatToBN,
  bnZero,
  getTokenInfo,
} from "../../../utils";
import { getAccountCoins } from "./common";
import { HubPoolClient, SpokePoolClient } from "../../../clients";
import { FinalizerPromise } from "../../types";

/**
 * Unlike other finalizers, the Binance finalizer is only used to withdraw EOA deposits on Binance.
 * This means we need to be cautious on the addresses to finalize, as a "finalization" is essentially a withdrawal
 * from a Binance hot wallet.
 */
export async function binanceL1ToL2Finalizer(
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
  const _depositHistory = await binanceApi.depositHistory({ startTime: fromTimestamp });

  // We must filter historical deposits and withdrawals based on the starting network. Since this is a L1 to L2 finalizer, deposits should originate on Ethereum.
  // And withdrawals should end on Binance Smart Chain.
  const depositHistory = Object.values(_depositHistory).filter((deposit) => deposit.network === "ETH");
  logger.debug({
    at: "BinanceL1ToL2Finalizer",
    message: `Found ${depositHistory.length} historical L1 deposits on Ethereum.`,
    fromTimestamp: fromTimestamp / 1_000,
  });

  // We also need to filter out deposits which are not ready to be finalized. A deposit.status of 1 means that the deposit has been fully processed and can be withdrawn on L2.
  const finalizableDeposits = depositHistory.filter((deposit) => deposit.status === 1);

  const accountCoins = await getAccountCoins(binanceApi);
  // The outer loop goes through the addresses we wish to finalize.
  for (const address of senderAddresses) {
    // Filter our list of deposits by the withdrawal address. We will only finalize deposits when the depositor EOA is in `senderAddresses`.
    const depositsInScope = await filterAsync(finalizableDeposits, async (deposit) => {
      const depositTxnReceipt = await hubSigner.provider.getTransactionReceipt(deposit.txId);
      return compareAddressesSimple(depositTxnReceipt.from, address);
    });
    if (depositsInScope.length === 0) {
      logger.debug({
        at: "BinanceL1ToL2Finalizer",
        message: `No finalizable deposits found for ${address}`,
        numberOfFinalizableDeposits: finalizableDeposits.length,
        fromTimestamp: fromTimestamp / 1_000,
      });
      continue;
    }
    // The inner loop finalizes all deposits for all supported tokens for the address.
    await mapAsync(SUPPORTED_TOKENS[chainId], async (symbol) => {
      const coin = accountCoins.find((coin) => coin.symbol === symbol);
      const networkLimits = coin.networkList.find((network) => network.name === "ETH");
      const l1Token = TOKEN_SYMBOLS_MAP[symbol].addresses[hubChainId];
      const { decimals: l1Decimals } = getTokenInfo(l1Token, hubChainId);
      const depositAmounts = depositsInScope
        .filter((deposit) => deposit.coin === symbol)
        .reduce((sum, deposit) => sum.add(floatToBN(deposit.amount, l1Decimals)), bnZero);
      const withdrawals = await binanceApi.withdrawHistory({ coin: symbol, startTime: fromTimestamp });
      const withdrawalsInScope = Object.values(withdrawals).filter(
        (withdrawal) => compareAddressesSimple(withdrawal.address, address) && withdrawal.network === "BSC"
      );
      const withdrawalAmounts = withdrawalsInScope.reduce(
        (sum, deposit) => sum.add(floatToBN(deposit.amount, l1Decimals)),
        bnZero
      );

      // The amount we are able to finalize is `depositAmounts - withdrawalAmounts`. It is possible for `depositAmounts` to be less than `withdrawalAmounts` if there is a gap between
      // the lookback windows used to query deposits and withdrawals, so we require this value to be > bnZero.
      const _amountToFinalize = depositAmounts.sub(withdrawalAmounts);
      const amountToFinalize = _amountToFinalize.gt(bnZero) ? Number(formatUnits(_amountToFinalize, l1Decimals)) : 0;

      // Additionally, binance imposes a minimum amount to withdraw. If the amount we want to finalize is less than the minimum (which may happen if there is dust left over from precision loss), then
      // do not attempt to withdraw anything.
      const canWithdraw =
        amountToFinalize >= Number(networkLimits.withdrawMin) && amountToFinalize <= Number(networkLimits.withdrawMax);
      logger.debug({
        at: "BinanceL1ToL2Finalizer",
        message: `${symbol} withdrawals for ${address}`,
        totalDepositedAmount: formatUnits(depositAmounts, l1Decimals),
        withdrawalAmount: formatUnits(withdrawalAmounts, l1Decimals),
        amountToFinalize,
        canWithdraw,
      });
      if (canWithdraw) {
        await binanceApi.withdraw({
          coin: symbol,
          address,
          network: "BSC",
          amount: amountToFinalize,
          transactionFeeFlag: false,
        });
        logger.info({
          at: "BinanceL1ToL2Finalizer",
          message: `Finalized ${symbol} deposit on BSC`,
          amount: amountToFinalize,
        });
      }
    });
  }
  return Promise.resolve({
    callData: [],
    crossChainMessages: [],
  });
}

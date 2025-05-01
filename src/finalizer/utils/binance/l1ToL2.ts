import Binance from "binance-api-node";
import { SUPPORTED_TOKENS } from "../../../common";
import { BaseChainAdapter } from "../../../adapter";
import { BinanceCEXBridge, BridgeEvents } from "../../../adapter/bridges";
import {
  winston,
  Signer,
  assert,
  isDefined,
  getTimestampForBlock,
  mapAsync,
  EvmAddress,
  getBinanceApiClient,
  TOKEN_SYMBOLS_MAP,
  compareAddressesSimple,
  filterAsync,
  formatUnits,
  floatToBN,
  bnZero,
  getTokenInfo,
} from "../../../utils";
import { HubPoolClient, SpokePoolClient } from "../../../clients";
import { FinalizerPromise, CrossChainMessage } from "../../types";

const DEFAULT_API_URL = "https://api.binance.com";
const MINIMUM_WITHDRAW_AMOUNTS: { [l1TokenSymbol: string]: number } = {
  USDC: 15,
};

/*
 * Unlike other finalizers, the Binance finalizer is only used to withdraw EOA deposits on Binance.
 * This means we can re-use a significant amount of logic defined in the BinanceCEXAdapter to help
 * determine the deposits we need to finalize.
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
  const l2EventSearchConfig = l2SpokePoolClient.eventSearchConfig;

  // Piggy-back off of the bridge logic for tracking outstanding transfer amounts.
  const allL1Bridges = Object.fromEntries(
    SUPPORTED_TOKENS[l2SpokePoolClient.chainId].map((symbol) => {
      const l2Provider = l2SpokePoolClient.spokePool.provider;
      const l1Token = TOKEN_SYMBOLS_MAP[symbol].addresses[hubChainId];
      const bridge = new BinanceCEXBridge(chainId, hubChainId, hubSigner, l2Provider, EvmAddress.from(l1Token));
      return [l1Token, bridge];
    })
  );

  // Gather historical deposit data only. This is because we can assume that the adapter's call to `getOutstandingCrossChainTransfers` will determine the amount
  // we have still in Binance, so we only care to know whether a deposit is ready to be withdrawn.
  const binanceApi = getBinanceApiClient(process.env["BINANCE_API_BASE"]);
  const fromTimestamp = (await getTimestampForBlock(hubSigner.provider, l1EventSearchConfig.fromBlock)) * 1_000;
  const _depositHistory = await binanceApi.depositHistory({ startTime: fromTimestamp });

  // We must filter historical deposits and withdrawals based on the starting network. Since this is a L1 to L2 finalizer, deposits should originate on Ethereum.
  const depositHistory = Object.values(_depositHistory).filter((deposit) => deposit.network === "ETH");
  logger.debug({
    at: "BinanceL1ToL2Finalizer",
    message: `Found ${depositHistory.length} historical L1 deposits on Binance`,
    fromTimestamp: fromTimestamp / 1_000,
  });

  // We also need to filter out deposits which are not ready to be finalized. A deposit.status of 1 means that the deposit has been fully processed and can be withdrawn on L2.
  const finalizableDeposits = depositHistory.filter((deposit) => deposit.status === 1);

  const coins = await binanceApi["accountCoins"]();
  console.log(Object.values(coins).filter((coin) => coin["coin"] === "USDC")[0]);

  const finalizedAmounts = {};
  // The outer loop goes through the addresses we wish to finalize.
  for (const address of senderAddresses) {
    const depositsInScope = await filterAsync(finalizableDeposits, async (deposit) => {
      const depositTxnReceipt = await hubSigner.provider.getTransactionReceipt(deposit.txId);
      return compareAddressesSimple(depositTxnReceipt.from, address);
    });
    if (depositsInScope.length === 0) {
      logger.debug({
        at: "BinanceL1ToL2Finalizer",
        message: `No finalizable deposits found for ${address}`,
        numberOfDeposits: finalizableDeposits.length,
        fromTimestamp: fromTimestamp / 1_000,
      });
      continue;
    }
    // The inner loop finalizes all deposits for all supported tokens for the address.
    const finalizationResults = await mapAsync(SUPPORTED_TOKENS[chainId], async (symbol) => {
      const l1Token = TOKEN_SYMBOLS_MAP[symbol].addresses[hubChainId];
      const { decimals: l1Decimals } = getTokenInfo(l1Token, hubChainId);
      const depositFinalizedEvents: BridgeEvents = await allL1Bridges[l1Token].queryL2BridgeFinalizationEvents(
        EvmAddress.from(l1Token),
        address,
        address,
        l2EventSearchConfig
      );
      const totalFinalizedAmount = Object.values(depositFinalizedEvents).reduce(
        (sum, events) => sum.add(events.reduce((_sum, event) => sum.add(event.amount), bnZero)),
        bnZero
      );
      const depositAmounts = depositsInScope
        .filter((deposit) => deposit.coin === symbol)
        .reduce((sum, deposit) => sum.add(floatToBN(deposit.amount, l1Decimals)), bnZero);

      // The amount we are able to finalize is `depositAmounts - totalFinalizedAmount`. It is possible for `depositAmounts` to be less than `totalFinalizedAmounts` if there is a gap between
      // the lookback windows used to query deposits and withdrawals, so we require this value to be > bnZero.
      const _amountToFinalize = depositAmounts.sub(totalFinalizedAmount);
      const amountToFinalize = _amountToFinalize.gt(bnZero) ? Number(formatUnits(_amountToFinalize, l1Decimals)) : 0;

      // Additionally, binance imposes a minimum amount to withdraw. If the amount we want to finalize is less than the minimum (which may happen if there is dust left over from precision loss), then
      // do not attempt to withdraw anything.
      const canWithdraw = amountToFinalize >= MINIMUM_WITHDRAW_AMOUNTS[symbol];
      logger.debug({
        at: "BinanceL1ToL2Finalizer",
        message: `${symbol} withdrawals for ${address}`,
        totalDepositedAmount: formatUnits(depositAmounts, l1Decimals),
        totalFinalizedAmount: formatUnits(totalFinalizedAmount, l1Decimals),
        amountToFinalize,
        canWithdraw,
      });
      if (canWithdraw) {
        const withdrawalResponse = await binanceApi.withdraw({
          coin: symbol,
          address,
          network: "BSC",
          amount: amountToFinalize,
          transactionFeeFlag: false,
        });
        console.log(withdrawalResponse);
      }
    });
  }
  return Promise.resolve({
    callData: [],
    crossChainMessages: [],
  });
}

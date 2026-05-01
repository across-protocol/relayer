import {
  winston,
  Signer,
  getTimestampForBlock,
  mapAsync,
  getBinanceApiClient,
  resolveAcrossToken,
  compareAddressesSimple,
  BigNumber,
  formatUnits,
  floatToBN,
  bnZero,
  getTokenInfo,
  groupObjectCountsByProp,
  isEVMSpokePoolClient,
  assert,
  EvmAddress,
  getBinanceDeposits,
  getBinanceWithdrawals,
  getAccountCoins,
  BINANCE_NETWORKS,
  isDefined,
  filterAsync,
  getBinanceDepositType,
  BinanceTransactionType,
  getBinanceWithdrawalType,
  isCompletedBinanceWithdrawal,
  resolveBinanceCoinSymbol,
  truncate,
  ethers,
} from "../../utils";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { FinalizerPromise, AddressesToFinalize } from "../types";
import { constructReadOnlyRebalancerClient } from "../../rebalancer/RebalancerClientHelper";

// Alias for a Binance deposit/withdrawal status.
enum Status {
  Confirmed = 1,
  Pending = 0,
  Rejected = 2,
  Credited = 6,
  WrongDeposit = 7,
  WaitingUserConfirm = 8,
}

// The precision of a `DECIMAL` type in the Binance API.
const DECIMAL_PRECISION = 1_000_000;
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
  _senderAddresses: AddressesToFinalize
): Promise<FinalizerPromise> {
  assert(isEVMSpokePoolClient(l1SpokePoolClient) && isEVMSpokePoolClient(l2SpokePoolClient));
  assert(isDefined(hubSigner.provider), "BinanceFinalizer: hubSigner has no provider");
  const senderAddresses = Object.fromEntries(
    Array.from(_senderAddresses.entries()).map(([senderAddress, tokensToFinalize]) => [
      senderAddress.toNative(),
      tokensToFinalize,
    ])
  );
  const hubChainId = l1SpokePoolClient.chainId;
  const l2ChainId = l2SpokePoolClient.chainId;
  const l1EventSearchConfig = l1SpokePoolClient.eventSearchConfig;

  const [binanceApi, _fromTimestamp] = await Promise.all([
    getBinanceApiClient(process.env["BINANCE_API_BASE"]),
    getTimestampForBlock(hubSigner.provider, l1EventSearchConfig.from),
  ]);
  const fromTimestamp = _fromTimestamp * 1_000;

  const [_binanceDeposits, accountCoins] = await Promise.all([
    getBinanceDeposits(binanceApi, fromTimestamp),
    getAccountCoins(binanceApi),
  ]);
  // Remove any _binanceDeposits that are marked as related to a swap. The reason why we check "!== SWAP" instead of
  // "=== BRIDGE" is because we want this code to be backwards compatible with the existing inventory client logic which
  // does not yet tag deposits with this BRIDGE type.
  const binanceSwapDepositAmount: { [symbol: string]: number } = {};
  const _binanceBridgeDeposits = await filterAsync(_binanceDeposits, async (deposit) => {
    const depositType = await getBinanceDepositType(deposit);
    if (depositType === BinanceTransactionType.SWAP) {
      binanceSwapDepositAmount[deposit.coin] ??= 0;
      binanceSwapDepositAmount[deposit.coin] += deposit.amount;
      return false;
    }
    return true;
  });

  const statusesGrouped = groupObjectCountsByProp(_binanceBridgeDeposits, (deposit: { status: number }) => {
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
    message: `Found ${_binanceBridgeDeposits.length} historical Binance deposits.`,
    statusesGrouped,
    fromTimestamp: fromTimestamp,
  });
  const binanceDeposits = _binanceBridgeDeposits.filter((deposit) => deposit.status === Status.Confirmed);
  const creditedDeposits = _binanceBridgeDeposits.filter((deposit) => deposit.status === Status.Credited);
  const pendingBinanceRebalanceDeductions = await getPendingBinanceRebalanceDeductions(
    logger,
    hubSigner,
    Object.keys(senderAddresses)
  );

  // We can run this in parallel since deposits for each tokens are independent of each other.
  await mapAsync(Object.entries(senderAddresses), async ([address, symbols]) => {
    for (const symbol of symbols) {
      const coin = accountCoins.find((coin) => coin.symbol === symbol);
      if (!isDefined(coin)) {
        logger.warn({
          at: "BinanceFinalizer",
          message: `Coin ${symbol} is not a Binance supported token.`,
        });
        continue;
      }
      let coinBalance = Number(coin.balance);
      const l1Token = resolveAcrossToken(symbol, hubChainId, true);
      const { decimals: l1Decimals } = getTokenInfo(EvmAddress.from(l1Token), hubChainId);
      const _withdrawals = await getBinanceWithdrawals(binanceApi, symbol, fromTimestamp);
      // Similar to the reasoning for filtering deposits, we need to filter withdrawals by removing any
      // that are explicitly marked as related to a swap. To make this backwards compatible, we check "!== SWAP" instead of "=== BRIDGE"
      // as the existing inventory client logic does not yet tag withdrawals with this BRIDGE type.
      const withdrawals = await filterAsync(_withdrawals, async (withdrawal) => {
        const withdrawalType = await getBinanceWithdrawalType(withdrawal);
        return isCompletedBinanceWithdrawal(withdrawal.status) && withdrawalType !== BinanceTransactionType.SWAP;
      });

      // @dev Since we cannot determine the address of the binance depositor without querying the transaction receipt, we need to assume that all tokens
      // with symbol `symbol` should be withdrawn to `address`.
      const depositsInScope = binanceDeposits.filter((deposit) => deposit.coin === symbol);
      const creditedDepositAmount = creditedDeposits
        .filter((deposit) => deposit.coin === symbol)
        .reduce((sum, deposit) => sum + deposit.amount, 0);
      // Start by finalizing L1 -> L2, then go to L2 -> L1.
      // @dev There are only two possible withdraw networks for the finalizer, Ethereum L1 or Binance Smart Chain "L2." Withdrawals to Ethereum can originate from any L2 but
      // must be finalized on L1. Withdrawals to Binance Smart Chain must originate from Ethereum L1.
      for (const withdrawNetwork of [BINANCE_NETWORKS[l2ChainId], BINANCE_NETWORKS[hubChainId]]) {
        const networkLimits = coin.networkList.find((network) => network.name === withdrawNetwork);
        if (!isDefined(networkLimits)) {
          continue;
        }
        // Get both the amount deposited and ready to be finalized and the amount already withdrawn on L2.
        const finalizingOnL2 = withdrawNetwork === BINANCE_NETWORKS[l2ChainId];
        const depositAmounts = depositsInScope
          .filter((deposit) =>
            finalizingOnL2
              ? deposit.network === BINANCE_NETWORKS[hubChainId]
              : deposit.network !== BINANCE_NETWORKS[hubChainId]
          )
          .reduce((sum, deposit) => sum.add(floatToBN(deposit.amount, l1Decimals)), bnZero);

        const withdrawalsInScope = withdrawals.filter(
          (withdrawal) =>
            compareAddressesSimple(withdrawal.recipient, address) && withdrawal.network === withdrawNetwork
        );
        const withdrawalAmounts = withdrawalsInScope.reduce(
          (sum, deposit) => sum.add(floatToBN(deposit.amount, l1Decimals)),
          bnZero
        );

        // The amount we are able to finalize is `depositAmounts - withdrawalAmounts`. It is possible for `depositAmounts` to be less than `withdrawalAmounts` if there is a gap between
        // the lookback windows used to query deposits and withdrawals, so we require this value to be > bnZero.
        const _amountToFinalize = depositAmounts.sub(withdrawalAmounts);
        let amountToFinalize = _amountToFinalize.gt(bnZero) ? Number(formatUnits(_amountToFinalize, l1Decimals)) : 0;
        const pendingRebalanceDeduction = pendingBinanceRebalanceDeductions[resolveBinanceCoinSymbol(symbol)] ?? 0;

        logger.debug({
          at: "BinanceFinalizer",
          message: `(X -> ${withdrawNetwork}) ${symbol} withdrawals for ${address}.`,
          totalDepositedAmount: formatUnits(depositAmounts, l1Decimals),
          withdrawalAmount: formatUnits(withdrawalAmounts, l1Decimals),
          amountToFinalize,
          pendingRebalanceDeduction,
        });
        // Additionally, binance imposes a minimum amount to withdraw. If the amount we want to finalize is less than the minimum, then
        // do not attempt to withdraw anything. Likewise, if the amount we want to withdraw is greater than the maximum, then warn and withdraw the maximum amount.
        if (amountToFinalize >= Number(networkLimits.withdrawMax)) {
          logger.warn({
            at: "BinanceFinalizer",
            message: `(X -> ${withdrawNetwork}) Cannot withdraw total amount ${amountToFinalize} ${symbol} since it is above the network limit ${networkLimits.withdrawMax}. Withdrawing the maximum amount instead.`,
          });
          amountToFinalize = Number(networkLimits.withdrawMax);
        }
        // Binance also takes fees from withdrawals. Since we are bundling together multiple deposits, it is possible that the amount we are trying to withdraw is slightly greater than our free balance
        // (since a prior withdrawal's fees were paid for in part from the current withdrawal's balance). In this case, set `amountToFinalize` as `min(amountToFinalize, accountBalance)`.
        if (amountToFinalize > coinBalance) {
          logger.debug({
            at: "BinanceFinalizer",
            message: `(X -> ${withdrawNetwork}) Need to reduce the amount to finalize since hot wallet balance is less than desired withdrawal amount.`,
            amountToFinalize,
            balance: coinBalance,
          });
          amountToFinalize = coinBalance;
        }
        // If the amount we can finalize is above the withdraw minimum for this network, and if the amount to finalize is within the amount of our balance which corresponds to _finalized_ not credited
        // deposits, then we can continue.
        const availableCoinBalance = Math.max(coinBalance - creditedDepositAmount - pendingRebalanceDeduction, 0);
        amountToFinalize = Math.min(Number(availableCoinBalance.toFixed(l1Decimals)), amountToFinalize);
        if (pendingRebalanceDeduction > 0) {
          logger.debug({
            at: "BinanceFinalizer",
            message: `Reducing ${symbol} withdrawal capacity for ${address} by pending Binance rebalance amount.`,
            pendingRebalanceDeduction,
            amountToFinalize,
            availableCoinBalance,
            pendingBinanceRebalanceDeductions,
          });
        }
        if (amountToFinalize >= Number(networkLimits.withdrawMin)) {
          // Lastly, we need to truncate the amount to withdraw to 6 decimal places.
          amountToFinalize = Math.floor(amountToFinalize * DECIMAL_PRECISION) / DECIMAL_PRECISION;
          // Balance from Binance is in 8 decimal places, so we need to truncate to 8 decimal places.
          coinBalance = Number((coinBalance - amountToFinalize).toFixed(8));
          const withdrawalId = await binanceApi.withdraw({
            coin: symbol,
            address,
            network: withdrawNetwork,
            amount: amountToFinalize,
            transactionFeeFlag: false,
          });
          logger.info({
            at: "BinanceFinalizer",
            message: `(X -> ${withdrawNetwork}) Finalized deposit on ${withdrawNetwork} for ${amountToFinalize} ${symbol}.`,
            amount: amountToFinalize,
            withdrawalId,
          });
        } else {
          logger.debug({
            at: "BinanceFinalizer",
            message: `(X -> ${withdrawNetwork}) ${amountToFinalize} is less than minimum withdrawable amount ${networkLimits.withdrawMin} for token ${symbol}.`,
            availableCoinBalance: coinBalance - creditedDepositAmount,
            coinBalance,
            creditedDepositAmount,
          });

          // If the confirmed coin balance minus any pending swap balances is greater than the withdraw minimum, and there is
          // nothing to withdraw in this lookback window, then we should try to sweep the balance to L1.
          if (withdrawNetwork === BINANCE_NETWORKS[hubChainId]) {
            const coinBalanceMinusSwapDeposits = getSweepableOrphanBinanceBalance(
              coinBalance,
              creditedDepositAmount,
              binanceSwapDepositAmount[symbol] ?? 0,
              pendingRebalanceDeduction
            );
            if (coinBalanceMinusSwapDeposits >= Number(networkLimits.withdrawMin)) {
              const withdrawMax = Number(networkLimits.withdrawMax);
              const cappedWithdraw = Math.min(coinBalanceMinusSwapDeposits, withdrawMax);
              logger.debug({
                at: "BinanceFinalizer",
                message: `Sweeping orphaned ${cappedWithdraw} ${symbol} balance for ${address}.`,
                coinBalance,
                creditedDepositAmount,
                swapDepositAmount: binanceSwapDepositAmount[symbol] ?? 0,
                pendingRebalanceDeduction,
              });
              // Lastly, we need to truncate the amount to withdraw to 6 decimal places
              const amountToSweep = truncate(cappedWithdraw, 6);
              const withdrawalId = await binanceApi.withdraw({
                coin: symbol,
                address,
                network: withdrawNetwork,
                amount: amountToSweep,
                transactionFeeFlag: false,
              });
              logger.info({
                at: "BinanceFinalizer",
                message: `🫃🏻 Swept orphaned ${symbol} balance to ${address} on ${withdrawNetwork}.`,
                amount: amountToSweep,
                withdrawalId,
              });
            }
          }
        }
      }
    }
  });
  return {
    callData: [],
    crossChainMessages: [],
  };
}

export function getSweepableOrphanBinanceBalance(
  coinBalance: number,
  creditedDepositAmount: number,
  swapDepositAmount: number,
  pendingRebalanceDeduction = 0
): number {
  return Math.max(coinBalance - creditedDepositAmount - swapDepositAmount - pendingRebalanceDeduction, 0);
}

async function getPendingBinanceRebalanceDeductions(
  logger: winston.Logger,
  hubSigner: Signer,
  recipientAddresses: string[]
): Promise<Record<string, number>> {
  const readOnlyRebalancerClient = await constructReadOnlyRebalancerClient(logger, hubSigner, ["binance"]);
  const lookupAccounts = getEvmBinanceRebalanceLookupAccounts(recipientAddresses, await hubSigner.getAddress());
  const pendingRebalances = (
    await Promise.all(lookupAccounts.map((account) => readOnlyRebalancerClient.getPendingRebalances(account)))
  ).reduce<{
    [chainId: number]: { [token: string]: BigNumber };
  }>((acc, pending) => {
    for (const [_chainId, tokenBalances] of Object.entries(pending)) {
      const chainId = Number(_chainId);
      acc[chainId] ??= {};
      for (const [token, amount] of Object.entries(tokenBalances)) {
        acc[chainId][token] = (acc[chainId][token] ?? bnZero).add(amount);
      }
    }
    return acc;
  }, {});
  return getPositivePendingRebalanceAmountsByBinanceCoin(pendingRebalances);
}

export function getEvmBinanceRebalanceLookupAccounts(addresses: string[], signerAddress?: string): EvmAddress[] {
  const seenAddresses = new Set<string>();
  return [...addresses, signerAddress]
    .filter(isDefined)
    .filter((address) => ethers.utils.isAddress(address))
    .map((address) => EvmAddress.from(address))
    .filter((address) => {
      const normalizedAddress = address.toNative();
      if (seenAddresses.has(normalizedAddress)) {
        return false;
      }
      seenAddresses.add(normalizedAddress);
      return true;
    });
}

export function getPositivePendingRebalanceAmountsByBinanceCoin(pendingRebalances: {
  [chainId: number]: { [token: string]: BigNumber };
}): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const [_chainId, tokenBalances] of Object.entries(pendingRebalances)) {
    const chainId = Number(_chainId);
    for (const [token, amount] of Object.entries(tokenBalances)) {
      const { decimals } = getTokenInfo(EvmAddress.from(resolveAcrossToken(token, chainId, true)), chainId);
      const binanceCoin = resolveBinanceCoinSymbol(token);
      totals[binanceCoin] = (totals[binanceCoin] ?? 0) + Number(formatUnits(amount, decimals));
    }
  }
  return Object.fromEntries(Object.entries(totals).filter(([_symbol, amount]) => amount > 0));
}

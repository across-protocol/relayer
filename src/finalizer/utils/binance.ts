import {
  winston,
  Signer,
  getTimestampForBlock,
  mapAsync,
  getBinanceApiClient,
  resolveAcrossToken,
  compareAddressesSimple,
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
  isSameBinanceCoin,
  getBinanceSpotMarketMetaForRoute,
  getMatchingBinanceFillForCloid,
  resolveBinanceCoinSymbol,
  SpotMarketMeta,
  truncate,
  ethers,
} from "../../utils";
import type { Binance as BinanceApi } from "binance-api-node";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { FinalizerPromise, AddressesToFinalize } from "../types";
import type { OrderDetails } from "../../rebalancer/utils/interfaces";
import {
  BINANCE_STABLECOIN_SWAP_REDIS_PREFIX,
  getPendingBridgeStatusSetKey,
  getRedisCacheForRebalancerStatusTracking,
  redisGetOrderDetailsForAdapter,
  STATUS,
} from "../../rebalancer/utils/utils";

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
const BINANCE_SWEEP_BLOCKING_STATUSES = [
  STATUS.PENDING_BRIDGE_PRE_DEPOSIT,
  STATUS.PENDING_DEPOSIT,
  STATUS.PENDING_SWAP,
  STATUS.PENDING_WITHDRAWAL,
];

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
  // Binance balances are shared across finalizer withdrawal recipients. Pending rebalance Redis state is keyed by
  // signer account, while finalizer withdrawal recipients can be configured separately, so include the running signer
  // in the lookup before using one symbol guard for the shared exchange account.
  const pendingRebalanceLookupAccounts = getEvmBinanceRebalanceLookupAccounts(
    Object.keys(senderAddresses),
    await hubSigner.getAddress()
  );
  const sharedBinanceAccountReservedRebalanceAmounts = sumPendingBinanceRebalanceSweepReservations(
    await Promise.all(
      pendingRebalanceLookupAccounts.map((account) =>
        getPendingBinanceRebalanceSweepReservationsForAccount(logger, account, binanceApi)
      )
    )
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

        logger.debug({
          at: "BinanceFinalizer",
          message: `(X -> ${withdrawNetwork}) ${symbol} withdrawals for ${address}.`,
          totalDepositedAmount: formatUnits(depositAmounts, l1Decimals),
          withdrawalAmount: formatUnits(withdrawalAmounts, l1Decimals),
          amountToFinalize,
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
        amountToFinalize = Math.min(
          Number((coinBalance - creditedDepositAmount).toFixed(l1Decimals)),
          amountToFinalize
        );
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
            const reservedRebalanceAmount =
              sharedBinanceAccountReservedRebalanceAmounts[resolveBinanceCoinSymbol(symbol)] ?? 0;
            const coinBalanceMinusSwapDeposits = getSweepableOrphanBinanceBalance(
              coinBalance,
              creditedDepositAmount,
              binanceSwapDepositAmount[symbol] ?? 0,
              reservedRebalanceAmount
            );
            if (reservedRebalanceAmount > 0) {
              logger.debug({
                at: "BinanceFinalizer",
                message: `Reducing orphaned ${symbol} sweep candidate for ${address} by pending Binance rebalance amount.`,
                reservedRebalanceAmount,
                coinBalanceMinusSwapDeposits,
                reservedRebalanceAmounts: sharedBinanceAccountReservedRebalanceAmounts,
              });
            }
            if (coinBalanceMinusSwapDeposits >= Number(networkLimits.withdrawMin)) {
              const withdrawMax = Number(networkLimits.withdrawMax);
              const cappedWithdraw = Math.min(coinBalanceMinusSwapDeposits, withdrawMax);
              logger.debug({
                at: "BinanceFinalizer",
                message: `Sweeping orphaned ${cappedWithdraw} ${symbol} balance for ${address}.`,
                coinBalance,
                creditedDepositAmount,
                swapDepositAmount: binanceSwapDepositAmount[symbol] ?? 0,
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
  reservedRebalanceAmount = 0
): number {
  return Math.max(coinBalance - creditedDepositAmount - swapDepositAmount - reservedRebalanceAmount, 0);
}

type PendingBinanceRebalanceSweepReservations = Record<string, number>;
type BinanceRebalanceReservationApi = Parameters<typeof getMatchingBinanceFillForCloid>[0] &
  Parameters<typeof getBinanceSpotMarketMetaForRoute>[0] &
  Pick<BinanceApi, "book">;
const CONSERVATIVE_UNKNOWN_DESTINATION_RESERVATION = Number.MAX_SAFE_INTEGER;

export function sumPendingBinanceRebalanceSweepReservations(
  reservations: PendingBinanceRebalanceSweepReservations[]
): PendingBinanceRebalanceSweepReservations {
  return reservations.reduce<PendingBinanceRebalanceSweepReservations>((acc, reservation) => {
    for (const [symbol, amount] of Object.entries(reservation)) {
      acc[symbol] = (acc[symbol] ?? 0) + amount;
    }
    return acc;
  }, {});
}

function addPendingBinanceRebalanceSweepReservation(
  reservations: PendingBinanceRebalanceSweepReservations,
  symbol: string,
  amount: number
): void {
  const binanceSymbol = resolveBinanceCoinSymbol(symbol);
  reservations[binanceSymbol] = (reservations[binanceSymbol] ?? 0) + amount;
}

function getReadableOrderAmount(order: Pick<OrderDetails, "sourceToken" | "sourceChain" | "amountToTransfer">): number {
  const { decimals } = getTokenInfo(
    EvmAddress.from(resolveAcrossToken(order.sourceToken, order.sourceChain, true)),
    order.sourceChain
  );
  return Number(formatUnits(order.amountToTransfer, decimals));
}

async function getEstimatedDestinationReservationAmount(
  binanceApi: Pick<BinanceApi, "book">,
  spotMarketMeta: SpotMarketMeta,
  sourceAmount: number
): Promise<number> {
  const book = await binanceApi.book({ symbol: spotMarketMeta.symbol, limit: 5 });
  const topLevel = spotMarketMeta.isBuy ? book.asks[0] : book.bids[0];
  assert(isDefined(topLevel), `Order book is empty for ${spotMarketMeta.symbol}`);
  const bestPrice = Number(topLevel.price);
  assert(bestPrice > 0, `Invalid best price ${topLevel.price} for ${spotMarketMeta.symbol}`);
  return spotMarketMeta.isBuy ? sourceAmount / bestPrice : sourceAmount * bestPrice;
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
    })
    .filter(isDefined);
}

export async function getPendingBinanceRebalanceSweepReservationsForAccount(
  logger: winston.Logger,
  account: EvmAddress,
  binanceApi: BinanceRebalanceReservationApi,
  getRedisCache = getRedisCacheForRebalancerStatusTracking
): Promise<PendingBinanceRebalanceSweepReservations> {
  try {
    const redisCache = await getRedisCache(logger);
    if (!isDefined(redisCache)) {
      return {};
    }

    const reservations = (
      await Promise.all(
        BINANCE_SWEEP_BLOCKING_STATUSES.map(async (status) => {
          const statusSetKey = getPendingBridgeStatusSetKey(
            BINANCE_STABLECOIN_SWAP_REDIS_PREFIX,
            status,
            account.toNative()
          );
          const cloids = await redisCache.sMembers(statusSetKey);
          return await Promise.all(
            cloids.map(async (cloid) => {
              const order = await redisGetOrderDetailsForAdapter(
                redisCache,
                BINANCE_STABLECOIN_SWAP_REDIS_PREFIX,
                cloid,
                account
              );
              if (!isDefined(order)) {
                logger.warn({
                  at: "BinanceFinalizer",
                  message:
                    "Found pending Binance rebalance status without order details; cannot reserve an amount for orphan sweep accounting.",
                  account: account.toNative(),
                  cloid,
                  statusSetKey,
                });
                return {};
              }
              return getPendingBinanceRebalanceSweepReservationsForOrder(logger, binanceApi, cloid, status, order);
            })
          );
        })
      )
    )
      .flat()
      .filter(isDefined);

    return sumPendingBinanceRebalanceSweepReservations(reservations);
  } catch (error) {
    logger.warn({
      at: "BinanceFinalizer",
      message: "Unable to load pending Binance rebalance state from Redis; continuing without this sweep guard.",
      account: account.toNative(),
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

export async function getPendingBinanceRebalanceSweepReservationsForOrder(
  logger: winston.Logger,
  binanceApi: BinanceRebalanceReservationApi,
  cloid: string,
  status: STATUS,
  order: OrderDetails
): Promise<PendingBinanceRebalanceSweepReservations> {
  const reservations: PendingBinanceRebalanceSweepReservations = {};
  if (status === STATUS.PENDING_BRIDGE_PRE_DEPOSIT) {
    return reservations;
  }

  const sourceAmount = getReadableOrderAmount(order);
  const routeRequiresSwap = !isSameBinanceCoin(order.sourceToken, order.destinationToken);
  if (!routeRequiresSwap || status === STATUS.PENDING_DEPOSIT) {
    addPendingBinanceRebalanceSweepReservation(reservations, order.sourceToken, sourceAmount);
    return reservations;
  }

  let spotMarketMeta: SpotMarketMeta | undefined;
  try {
    spotMarketMeta = await getBinanceSpotMarketMetaForRoute(binanceApi, order.sourceToken, order.destinationToken);
    const matchingFill = await getMatchingBinanceFillForCloid(binanceApi, cloid, spotMarketMeta);
    if (matchingFill) {
      addPendingBinanceRebalanceSweepReservation(
        reservations,
        order.destinationToken,
        matchingFill.expectedAmountToReceive
      );
      return reservations;
    }
  } catch (error) {
    logger.warn({
      at: "BinanceFinalizer",
      message: "Unable to load Binance fill details for pending rebalance; reserving estimated destination amount.",
      cloid,
      sourceToken: order.sourceToken,
      destinationToken: order.destinationToken,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    spotMarketMeta ??= await getBinanceSpotMarketMetaForRoute(binanceApi, order.sourceToken, order.destinationToken);
    addPendingBinanceRebalanceSweepReservation(
      reservations,
      order.destinationToken,
      await getEstimatedDestinationReservationAmount(binanceApi, spotMarketMeta, sourceAmount)
    );
    return reservations;
  } catch (error) {
    logger.warn({
      at: "BinanceFinalizer",
      message:
        "Unable to estimate Binance destination amount for pending rebalance; reserving destination token conservatively.",
      cloid,
      sourceToken: order.sourceToken,
      destinationToken: order.destinationToken,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  addPendingBinanceRebalanceSweepReservation(
    reservations,
    order.destinationToken,
    CONSERVATIVE_UNKNOWN_DESTINATION_RESERVATION
  );
  return reservations;
}

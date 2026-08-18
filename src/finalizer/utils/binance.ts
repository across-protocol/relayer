import {
  winston,
  Signer,
  getTimestampForBlock,
  getBinanceApiClient,
  resolveAcrossToken,
  compareAddressesSimple,
  BigNumber,
  formatUnits,
  floatToBN,
  bnZero,
  getTokenInfo,
  getTokenInfoFromSymbol,
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
  submitBinanceWithdrawal,
  isCompletedBinanceWithdrawal,
  resolveBinanceCoinSymbol,
  truncate,
  ethers,
  BinanceDeposit,
  AttributedBinanceDeposit,
  getAttributedBinanceDeposits,
  QueryBinanceErc20Transfers,
  BINANCE_SWEEP_WITHDRAW_ORDER_ID_PREFIX,
  isBinanceSweepWithdrawal,
  CHAIN_IDs,
  EventSearchConfig,
  Provider,
  BINANCE_DEPOSIT_STATUS,
  getProvider,
  getBlockForTimestamp,
} from "../../utils";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { CHAIN_MAX_BLOCK_LOOKBACK, hasBinanceRoute } from "../../common";
import { FinalizerPromise, AddressesToFinalize } from "../types";
import { constructAdapter } from "../../rebalancer/RebalancerClientHelper";

// The precision of a `DECIMAL` type in the Binance API.
const DECIMAL_PRECISION = 1_000_000;

type DepositAttributionClient = {
  chainId: number;
  provider: Provider;
  eventSearchConfig: EventSearchConfig;
};
export type BinanceFinalizerDependencies = {
  constructAdapter: typeof constructAdapter;
  getAccountCoins: typeof getAccountCoins;
  getBinanceApiClient: typeof getBinanceApiClient;
  getBinanceDeposits: typeof getBinanceDeposits;
  getBinanceDepositType: typeof getBinanceDepositType;
  getOwnedBinanceDeposits: typeof getOwnedBinanceDeposits;
  getBinanceWithdrawals: typeof getBinanceWithdrawals;
  getBinanceWithdrawalType: typeof getBinanceWithdrawalType;
  getTimestampForBlock: typeof getTimestampForBlock;
  getBlockForTimestamp: typeof getBlockForTimestamp;
  getProvider: typeof getProvider;
  hasBinanceRoute: typeof hasBinanceRoute;
  isEVMSpokePoolClient: typeof isEVMSpokePoolClient;
  submitBinanceWithdrawal: typeof submitBinanceWithdrawal;
};
const defaultDependencies: BinanceFinalizerDependencies = {
  constructAdapter,
  getAccountCoins,
  getBinanceApiClient,
  getBinanceDeposits,
  getBinanceDepositType,
  getOwnedBinanceDeposits,
  getBinanceWithdrawals,
  getBinanceWithdrawalType,
  getTimestampForBlock,
  getBlockForTimestamp,
  getProvider,
  hasBinanceRoute,
  isEVMSpokePoolClient,
  submitBinanceWithdrawal,
};
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
  _senderAddresses: AddressesToFinalize,
  dependencies: BinanceFinalizerDependencies = defaultDependencies
): Promise<FinalizerPromise> {
  assert(dependencies.isEVMSpokePoolClient(l1SpokePoolClient) && dependencies.isEVMSpokePoolClient(l2SpokePoolClient));
  assert(isDefined(hubSigner.provider), "BinanceFinalizer: hubSigner has no provider");
  const senderAddresses = Object.fromEntries(
    Array.from(_senderAddresses.entries()).map(([senderAddress, tokensToFinalize]) => [
      senderAddress.toNative(),
      tokensToFinalize,
    ])
  );
  const configuredSymbols = new Set(Object.values(senderAddresses).flat());
  if (configuredSymbols.size === 0) {
    return { callData: [], crossChainMessages: [] };
  }
  const hubChainId = l1SpokePoolClient.chainId;
  const l2ChainId = l2SpokePoolClient.chainId;
  const l1EventSearchConfig = l1SpokePoolClient.eventSearchConfig;

  const [binanceApi, _fromTimestamp] = await Promise.all([
    dependencies.getBinanceApiClient(process.env["BINANCE_API_BASE"]),
    dependencies.getTimestampForBlock(hubSigner.provider, l1EventSearchConfig.from),
  ]);
  const fromTimestamp = _fromTimestamp * 1_000;

  const [_binanceDeposits, accountCoins] = await Promise.all([
    dependencies.getBinanceDeposits(binanceApi, fromTimestamp),
    dependencies.getAccountCoins(binanceApi),
  ]);
  // Remove any _binanceDeposits that are marked as related to a swap. The reason why we check "!== SWAP" instead of
  // "=== BRIDGE" is because we want this code to be backwards compatible with the existing inventory client logic which
  // does not yet tag deposits with this BRIDGE type.
  const binanceSwapDepositAmount: { [symbol: string]: number } = {};
  const _binanceBridgeDeposits = await filterAsync(_binanceDeposits, async (deposit) => {
    const depositType = await dependencies.getBinanceDepositType(deposit);
    if (depositType === BinanceTransactionType.SWAP) {
      binanceSwapDepositAmount[deposit.coin] ??= 0;
      binanceSwapDepositAmount[deposit.coin] += deposit.amount;
      return false;
    }
    return true;
  });
  const chainIdsByNetwork = Object.fromEntries(
    Object.entries(BINANCE_NETWORKS).map(([chainId, network]) => [network, Number(chainId)])
  );
  const supportedBinanceBridgeDeposits = _binanceBridgeDeposits.filter(({ coin, network, status }) => {
    const chainId = chainIdsByNetwork[network];
    return (
      configuredSymbols.has(coin) &&
      status === BINANCE_DEPOSIT_STATUS.CONFIRMED &&
      isDefined(chainId) &&
      (chainId === hubChainId ||
        dependencies.hasBinanceRoute(chainId, EvmAddress.from(resolveAcrossToken(coin, hubChainId, true))))
    );
  });
  const networks = new Set(supportedBinanceBridgeDeposits.map(({ network }) => network));
  const clientsByNetwork = Object.fromEntries(
    await Promise.all(
      Array.from(networks).map(async (network) => {
        const chainId = chainIdsByNetwork[network];
        const provider = await dependencies.getProvider(chainId);
        const [from, to] = await Promise.all([
          dependencies.getBlockForTimestamp(logger, chainId, _fromTimestamp),
          provider.getBlockNumber(),
        ]);
        return [
          network,
          { chainId, provider, eventSearchConfig: { from, to, maxLookBack: CHAIN_MAX_BLOCK_LOOKBACK[chainId] } },
        ];
      })
    )
  );

  const ownedBinanceBridgeDeposits = await dependencies.getOwnedBinanceDeposits(
    supportedBinanceBridgeDeposits,
    clientsByNetwork
  );
  assertAllConfirmedBinanceDepositsAttributed(supportedBinanceBridgeDeposits, ownedBinanceBridgeDeposits);
  logger.debug({
    at: "BinanceFinalizer",
    message: `Found ${ownedBinanceBridgeDeposits.length} attributable historical Binance deposits.`,
    statusesGrouped: { "ready-to-finalize": ownedBinanceBridgeDeposits.length },
    fromTimestamp: fromTimestamp,
    unattributedDeposits: supportedBinanceBridgeDeposits.length - ownedBinanceBridgeDeposits.length,
  });
  const binanceDeposits = ownedBinanceBridgeDeposits;
  // Reserve all credited deposits, including ones whose receipt could not be resolved, so unattributed funds cannot
  // become sweepable merely because an RPC lookup failed.
  const creditedDeposits = _binanceBridgeDeposits.filter(
    (deposit) => deposit.status === BINANCE_DEPOSIT_STATUS.CREDITED
  );
  const pendingBinanceRebalanceDeductions = await getPendingBinanceRebalanceDeductions(
    logger,
    hubSigner,
    Object.keys(senderAddresses),
    dependencies.constructAdapter
  );

  const coinBalances = Object.fromEntries(accountCoins.map((coin) => [coin.symbol, Number(coin.balance)]));
  const ownedDepositKeys = new Set(ownedBinanceBridgeDeposits.map(({ network, txId }) => `${network}:${txId}`));
  const remainingAttributedBalances = _binanceBridgeDeposits
    .filter(
      ({ network, txId, status }) =>
        status === BINANCE_DEPOSIT_STATUS.CONFIRMED && !ownedDepositKeys.has(`${network}:${txId}`)
    )
    .reduce<Record<string, number>>((balances, deposit) => {
      balances[deposit.coin] = (balances[deposit.coin] ?? 0) + deposit.amount;
      return balances;
    }, {});
  binanceDeposits.forEach((deposit) => {
    const authorized = Object.entries(senderAddresses).some(
      ([address, symbols]) => symbols.includes(deposit.coin) && compareAddressesSimple(address, deposit.depositor)
    );
    if (!authorized) {
      remainingAttributedBalances[deposit.coin] = (remainingAttributedBalances[deposit.coin] ?? 0) + deposit.amount;
    }
  });
  const withdrawalsBySymbol = new Map<string, Awaited<ReturnType<typeof getBinanceWithdrawals>>>();

  // All EOAs consume the same Binance balances, so process them serially and decrement one shared balance per coin.
  for (const [address, symbols] of Object.entries(senderAddresses)) {
    for (const symbol of symbols) {
      const coin = accountCoins.find((coin) => coin.symbol === symbol);
      if (!isDefined(coin)) {
        logger.warn({
          at: "BinanceFinalizer",
          message: `Coin ${symbol} is not a Binance supported token.`,
        });
        continue;
      }
      const l1Token = resolveAcrossToken(symbol, hubChainId, true);
      const { decimals: l1Decimals } = getTokenInfo(EvmAddress.from(l1Token), hubChainId);
      let _withdrawals = withdrawalsBySymbol.get(symbol);
      if (!isDefined(_withdrawals)) {
        _withdrawals = await dependencies.getBinanceWithdrawals(binanceApi, symbol, fromTimestamp);
        withdrawalsBySymbol.set(symbol, _withdrawals);
      }
      // Similar to the reasoning for filtering deposits, we need to filter withdrawals by removing any
      // that are explicitly marked as related to a swap. To make this backwards compatible, we check "!== SWAP" instead of "=== BRIDGE"
      // as the existing inventory client logic does not yet tag withdrawals with this BRIDGE type.
      const withdrawals = await filterAsync(_withdrawals, async (withdrawal) => {
        const withdrawalType = await dependencies.getBinanceWithdrawalType(withdrawal);
        return (
          isCompletedBinanceWithdrawal(withdrawal.status) &&
          withdrawalType !== BinanceTransactionType.SWAP &&
          !isBinanceSweepWithdrawal(withdrawal)
        );
      });

      const depositsInScope = binanceDeposits.filter(
        (deposit) => deposit.coin === symbol && compareAddressesSimple(deposit.depositor, address)
      );
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
        remainingAttributedBalances[symbol] = (remainingAttributedBalances[symbol] ?? 0) + amountToFinalize;
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
        const coinBalance = coinBalances[symbol];
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
        const withdrawFee = Number(networkLimits.withdrawFee);
        const availableCoinBalance = Math.max(
          coinBalance - creditedDepositAmount - pendingRebalanceDeduction - withdrawFee,
          0
        );
        amountToFinalize = Math.min(Number(availableCoinBalance.toFixed(l1Decimals)), amountToFinalize);
        if (amountToFinalize >= Number(networkLimits.withdrawMin)) {
          // Lastly, we need to truncate the amount to withdraw to 6 decimal places.
          amountToFinalize = Math.floor(amountToFinalize * DECIMAL_PRECISION) / DECIMAL_PRECISION;
          // Balance from Binance is in 8 decimal places, so we need to truncate to 8 decimal places.
          const withdrawalId = await dependencies.submitBinanceWithdrawal(binanceApi, {
            coin: symbol,
            address,
            network: withdrawNetwork,
            amount: amountToFinalize,
            transactionFeeFlag: false,
          });
          coinBalances[symbol] = Number(Math.max(coinBalance - amountToFinalize - withdrawFee, 0).toFixed(8));
          remainingAttributedBalances[symbol] -= amountToFinalize;
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
        }
      }
    }
  }

  for (const symbol of configuredSymbols) {
    const coin = accountCoins.find((coin) => coin.symbol === symbol);
    const networkLimits = coin?.networkList.find((network) => network.name === BINANCE_NETWORKS[hubChainId]);
    if (!isDefined(coin) || !isDefined(networkLimits)) {
      continue;
    }
    const creditedDepositAmount = creditedDeposits
      .filter((deposit) => deposit.coin === symbol)
      .reduce((sum, deposit) => sum + deposit.amount, 0);
    const pendingRebalanceDeduction = pendingBinanceRebalanceDeductions[resolveBinanceCoinSymbol(symbol)] ?? 0;
    const amountToSweep = truncate(
      Math.min(
        getSweepableOrphanBinanceBalance(
          coinBalances[symbol],
          creditedDepositAmount,
          binanceSwapDepositAmount[symbol] ?? 0,
          pendingRebalanceDeduction,
          remainingAttributedBalances[symbol] ?? 0
        ),
        Number(networkLimits.withdrawMax),
        Math.max(coinBalances[symbol] - Number(networkLimits.withdrawFee), 0)
      ),
      6
    );
    if (amountToSweep < Number(networkLimits.withdrawMin)) {
      continue;
    }
    const sweepRecipient = Object.entries(senderAddresses).find(([_address, symbols]) => symbols.includes(symbol))?.[0];
    assert(isDefined(sweepRecipient));
    const withdrawalId = await dependencies.submitBinanceWithdrawal(binanceApi, {
      coin: symbol,
      address: sweepRecipient,
      network: BINANCE_NETWORKS[hubChainId],
      amount: amountToSweep,
      transactionFeeFlag: false,
      withdrawOrderId: `${BINANCE_SWEEP_WITHDRAW_ORDER_ID_PREFIX}${symbol}-${Date.now()}`,
    });
    logger.info({
      at: "BinanceFinalizer",
      message: `🫃🏻 Swept orphaned ${symbol} balance to ${sweepRecipient} on ${BINANCE_NETWORKS[hubChainId]}.`,
      amount: amountToSweep,
      withdrawalId,
    });
  }
  return {
    callData: [],
    crossChainMessages: [],
  };
}

export async function getOwnedBinanceDeposits(
  deposits: BinanceDeposit[],
  clientsByNetwork: Record<string, DepositAttributionClient>,
  queryErc20Transfers?: QueryBinanceErc20Transfers
): Promise<AttributedBinanceDeposit[]> {
  const groups = Object.values(
    Object.groupBy(
      deposits.filter(({ network }) => isDefined(clientsByNetwork[network])),
      ({ network, coin }) => `${network}:${coin}`
    )
  ).filter(isDefined);
  return (
    await Promise.all(
      groups.map((group) => {
        const client = clientsByNetwork[group[0].network];
        const tokenAddress =
          group[0].coin === "ETH" && client.chainId === CHAIN_IDs.MAINNET
            ? undefined
            : getTokenInfoFromSymbol(group[0].coin, client.chainId).address.toNative();
        return getAttributedBinanceDeposits(
          group,
          client.provider,
          client.eventSearchConfig,
          tokenAddress,
          queryErc20Transfers
        );
      })
    )
  ).flat();
}

export function assertAllConfirmedBinanceDepositsAttributed(
  deposits: BinanceDeposit[],
  ownedDeposits: AttributedBinanceDeposit[]
): void {
  const ownedDepositKeys = new Set(ownedDeposits.map(({ network, txId }) => `${network}:${txId}`));
  const unattributed = deposits.filter(
    ({ network, txId, status }) =>
      status === BINANCE_DEPOSIT_STATUS.CONFIRMED && !ownedDepositKeys.has(`${network}:${txId}`)
  );
  assert(
    unattributed.length === 0,
    `Cannot safely finalize ${unattributed.length} confirmed Binance deposit(s) without depositor attribution`
  );
}

export function getSweepableOrphanBinanceBalance(
  coinBalance: number,
  creditedDepositAmount: number,
  swapDepositAmount: number,
  pendingRebalanceDeduction = 0,
  attributedDepositAmount = 0
): number {
  return Math.max(
    coinBalance - creditedDepositAmount - swapDepositAmount - pendingRebalanceDeduction - attributedDepositAmount,
    0
  );
}

async function getPendingBinanceRebalanceDeductions(
  logger: winston.Logger,
  hubSigner: Signer,
  recipientAddresses: string[],
  createAdapter: typeof constructAdapter
): Promise<Record<string, number>> {
  const binanceAdapter = await createAdapter(logger, hubSigner, "binance");
  const lookupAccounts = getEvmBinanceRebalanceLookupAccounts(recipientAddresses, await hubSigner.getAddress());
  const pendingRebalances = (
    await Promise.all(lookupAccounts.map((account) => binanceAdapter.getPendingRebalances(account)))
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
      // Pending rebalances are keyed by logical symbol (e.g. "USDC") even where the on-chain symbol
      // differs (e.g. "USDC-BNB" on BSC); getTokenInfoFromSymbol routes through TOKEN_EQUIVALENCE_REMAPPING.
      const { decimals } = getTokenInfoFromSymbol(token, chainId);
      const binanceCoin = resolveBinanceCoinSymbol(token);
      totals[binanceCoin] = (totals[binanceCoin] ?? 0) + Number(formatUnits(amount, decimals));
    }
  }
  return Object.fromEntries(Object.entries(totals).filter(([_symbol, amount]) => amount > 0));
}

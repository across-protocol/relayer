import {
  assert,
  BigNumber,
  BINANCE_NETWORKS,
  Coin,
  createFormatFunction,
  EvmAddress,
  floatToBN,
  getAccountCoins,
  getNetworkName,
  getTokenInfo,
  isDefined,
  isSameBinanceCoin,
} from "../../utils";
import { BridgeTransactionDetails } from "./BaseBridgeAdapter";
import { BinanceCEXBridge } from "./BinanceCEXBridge";

/**
 * Assert that Binance can currently withdraw `amount` of `coinSymbol` onto `networkName`.
 *
 * Exported separately from the adapter so the guard is unit-testable without standing up a Binance
 * API client. `amount` and `decimals` are both denominated in the L1 token.
 */
export function assertBinanceWithdrawalRoute(
  coins: Coin[],
  coinSymbol: string,
  networkName: string,
  amount: BigNumber,
  decimals: number
): void {
  const coin = coins.find(({ symbol }) => isSameBinanceCoin(symbol, coinSymbol));
  const network = coin?.networkList?.find(({ name }) => name === networkName);
  assert(isDefined(network), `Binance lists no ${coinSymbol} route on ${networkName}`);

  // Binance keeps suspended coin/network pairs listed in `networkList`, so `withdrawEnable` is the
  // only pre-trade signal that the withdrawal leg will be rejected. Binance omits the flag on some
  // responses; treat absent as enabled, since a missing flag is not evidence of suspension.
  assert(network.withdrawEnable ?? true, `Binance has suspended ${coinSymbol} withdrawals on ${networkName}`);

  const format = createFormatFunction(2, 4, false, decimals);
  const [min, max] = [network.withdrawMin, network.withdrawMax].map((bound) => floatToBN(bound, decimals));
  assert(
    amount.gte(min),
    `${format(amount)} ${coinSymbol} is below the ${format(min)} ${networkName} withdrawal minimum`
  );
  assert(
    amount.lte(max),
    `${format(amount)} ${coinSymbol} exceeds the ${format(max)} ${networkName} withdrawal maximum`
  );
}

/**
 * Same-asset (like-for-like) rebalance bridge routed through Binance.
 *
 * Execution is identical to {@link BinanceCEXBridge}: the L1 leg is a plain ERC20 transfer into the
 * Binance deposit address, and the destination leg is completed asynchronously by the Binance
 * finalizer. What this adapter adds is a pre-flight check on the *destination* withdrawal leg.
 *
 * That check matters because the L1 deposit is not reversible from here. Committing funds to a
 * suspended or out-of-bounds coin/network pair strands the tranche on the exchange until its TTL
 * elapses and the finalizer reclaims it, so it is strictly better to decline the rebalance. Callers
 * treat a throw as "skip": `InventoryClient.rebalanceInventoryIfNeeded` catches, logs, and moves on
 * without committing funds.
 */
export class SameAssetRebalancer_Binance extends BinanceCEXBridge {
  override async constructL1ToL2Txn(
    _toAddress: EvmAddress,
    l1Token: EvmAddress,
    _l2Token: EvmAddress,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    const networkName = BINANCE_NETWORKS[this.l2chainId];
    assert(isDefined(networkName), `Binance does not support ${getNetworkName(this.l2chainId)}`);

    const coins = await getAccountCoins(await this.getBinanceClient());
    const { decimals } = getTokenInfo(l1Token, this.hubChainId);
    assertBinanceWithdrawalRoute(coins, this.tokenSymbol, networkName, amount, decimals);

    return super.constructL1ToL2Txn(_toAddress, l1Token, _l2Token, amount);
  }
}

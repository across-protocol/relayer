import { expect, sinon } from "./utils";
import {
  getEvmBinanceRebalanceLookupAccounts,
  getPositivePendingRebalanceAmountsByBinanceCoin,
  getSweepableOrphanBinanceBalance,
  sumBinanceCoinAmounts,
} from "../src/finalizer/utils/binance";
import { bnZero, CHAIN_IDs, EvmAddress, toBNWei } from "../src/utils";

describe("Binance finalizer helpers", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("converts positive Binance pending rebalances into withdrawal deductions", function () {
    const deductions = getPositivePendingRebalanceAmountsByBinanceCoin({
      [CHAIN_IDs.MAINNET]: {
        USDC: toBNWei("100", 6),
        WETH: toBNWei("1", 18),
        USDT: bnZero.sub(toBNWei("10", 6)),
      },
    });

    expect(deductions).to.deep.equal({ USDC: 100, ETH: 1 });
  });

  it("nets pending rebalance amounts by Binance coin before applying positive deductions", function () {
    const deductions = getPositivePendingRebalanceAmountsByBinanceCoin({
      [CHAIN_IDs.MAINNET]: {
        USDC: toBNWei("100", 6),
      },
      [CHAIN_IDs.ARBITRUM]: {
        USDC: bnZero.sub(toBNWei("40", 6)),
        WETH: bnZero.sub(toBNWei("1", 18)),
      },
    });

    expect(deductions).to.deep.equal({ USDC: 60 });
  });

  it("resolves logical USDC symbol on BSC where the on-chain symbol is USDC-BNB", function () {
    const deductions = getPositivePendingRebalanceAmountsByBinanceCoin({
      [CHAIN_IDs.BSC]: {
        USDC: toBNWei("50", 18),
      },
    });

    expect(deductions).to.deep.equal({ USDC: 50 });
  });

  it("resolves logical USDT symbol on BSC where the on-chain symbol is USDT-BNB", function () {
    const deductions = getPositivePendingRebalanceAmountsByBinanceCoin({
      [CHAIN_IDs.BSC]: {
        USDT: toBNWei("75", 18),
      },
    });

    expect(deductions).to.deep.equal({ USDT: 75 });
  });

  it("sums destination-side and pending-deposit source-side deductions by Binance coin", function () {
    const merged = sumBinanceCoinAmounts({ USDC: 100 }, { USDT: 75, USDC: 25 });

    expect(merged).to.deep.equal({ USDC: 125, USDT: 75 });
  });

  it("keeps pending-deposit source deductions when destination-side adjustments net negative for the same coin", function () {
    // A pending USDT -> USDC swap order in PENDING_DEPOSIT protects its USDT input via the source-side map. A
    // negative destination-side adjustment for the same coin (e.g. an intermediate bridge leg of another order)
    // must not cancel that protection, so each map is netted to positive amounts before the two are summed.
    const destinationSide = getPositivePendingRebalanceAmountsByBinanceCoin({
      [CHAIN_IDs.ARBITRUM]: {
        USDT: bnZero.sub(toBNWei("50", 6)),
      },
    });
    const sourceSide = getPositivePendingRebalanceAmountsByBinanceCoin({
      [CHAIN_IDs.BSC]: {
        USDT: toBNWei("75", 18),
      },
    });

    expect(sumBinanceCoinAmounts(destinationSide, sourceSide)).to.deep.equal({ USDT: 75 });
  });

  it("subtracts credited, swap, and pending rebalance amounts from orphan sweep candidates", function () {
    const sweepableBalance = getSweepableOrphanBinanceBalance(250_000, 10_000, 20_000, 30_000);

    expect(sweepableBalance).to.equal(190_000);
  });

  it("skips non-EVM addresses when collecting pending rebalance accounts", function () {
    const evmAddress = "0x0000000000000000000000000000000000000001";
    const svmAddress = "11111111111111111111111111111111";

    const accounts = getEvmBinanceRebalanceLookupAccounts([evmAddress, svmAddress]);

    expect(accounts.map((account) => account.toNative())).to.deep.equal([EvmAddress.from(evmAddress).toNative()]);
  });

  it("includes the signer account when collecting pending rebalance accounts", function () {
    const recipientAddress = "0x0000000000000000000000000000000000000001";
    const signerAddress = "0x0000000000000000000000000000000000000002";

    const accounts = getEvmBinanceRebalanceLookupAccounts([recipientAddress], signerAddress);

    expect(accounts.map((account) => account.toNative())).to.deep.equal([
      EvmAddress.from(recipientAddress).toNative(),
      EvmAddress.from(signerAddress).toNative(),
    ]);
  });
});

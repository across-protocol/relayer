import { expect, sinon } from "./utils";
import {
  getEvmBinanceRebalanceLookupAccounts,
  getPositivePendingRebalanceAmountsByBinanceCoin,
  getSweepableOrphanBinanceBalance,
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

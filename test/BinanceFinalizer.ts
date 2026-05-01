import { expect } from "./utils";
import {
  getEvmBinanceRebalanceLookupAccounts,
  getPendingBinanceRebalanceSymbols,
  getSweepableOrphanBinanceBalance,
} from "../src/finalizer/utils/binance";
import { EvmAddress } from "../src/utils";

describe("Binance finalizer helpers", function () {
  it("collects Binance symbols from pending rebalancer orders", function () {
    const symbols = getPendingBinanceRebalanceSymbols([
      {
        sourceToken: "USDT",
        destinationToken: "USDC",
      },
      {
        sourceToken: "WETH",
        destinationToken: "USDT",
      },
    ]);

    expect([...symbols].sort()).to.deep.equal(["ETH", "USDC", "USDT"]);
  });

  it("subtracts credited and swap deposits from orphan sweep candidates", function () {
    const sweepableBalance = getSweepableOrphanBinanceBalance(250_000, 10_000, 20_000);

    expect(sweepableBalance).to.equal(220_000);
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

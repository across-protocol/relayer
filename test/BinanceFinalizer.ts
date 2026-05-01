import { expect } from "./utils";
import { getPendingBinanceRebalanceSymbols, getSweepableOrphanBinanceBalance } from "../src/finalizer/utils/binance";

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
});

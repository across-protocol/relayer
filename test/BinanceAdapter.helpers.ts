import { expect } from "./utils";
import { deriveBinanceSpotMarketMeta } from "../src/rebalancer/adapters/binance";

describe("Binance adapter helpers", async function () {
  it("derives buy-side market metadata for USDT -> USDC routes", async function () {
    const usdcUsdtSymbol = {
      symbol: "USDCUSDT",
      baseAsset: "USDC",
      quoteAsset: "USDT",
      filters: [
        { filterType: "PRICE_FILTER", tickSize: "0.00010000" },
        { filterType: "LOT_SIZE", stepSize: "1.00000000", minQty: "1.00000000" },
      ],
    } as const;

    const meta = deriveBinanceSpotMarketMeta("USDT", "USDC", usdcUsdtSymbol as never);

    expect(meta.symbol).to.equal("USDCUSDT");
    expect(meta.baseAssetName).to.equal("USDC");
    expect(meta.quoteAssetName).to.equal("USDT");
    expect(meta.pxDecimals).to.equal(4);
    expect(meta.szDecimals).to.equal(0);
    expect(meta.minimumOrderSize).to.equal(1);
    expect(meta.isBuy).to.equal(true);
  });

  it("derives sell-side market metadata for USDC -> USDT routes", async function () {
    const usdcUsdtSymbol = {
      symbol: "USDCUSDT",
      baseAsset: "USDC",
      quoteAsset: "USDT",
      filters: [
        { filterType: "PRICE_FILTER", tickSize: "0.00010000" },
        { filterType: "LOT_SIZE", stepSize: "1.00000000", minQty: "1.00000000" },
      ],
    } as const;

    const meta = deriveBinanceSpotMarketMeta("USDC", "USDT", usdcUsdtSymbol as never);

    expect(meta.symbol).to.equal("USDCUSDT");
    expect(meta.baseAssetName).to.equal("USDC");
    expect(meta.quoteAssetName).to.equal("USDT");
    expect(meta.pxDecimals).to.equal(4);
    expect(meta.szDecimals).to.equal(0);
    expect(meta.minimumOrderSize).to.equal(1);
    expect(meta.isBuy).to.equal(false);
  });
});

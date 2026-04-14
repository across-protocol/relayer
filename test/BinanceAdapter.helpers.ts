import { BinanceStablecoinSwapAdapter, deriveBinanceSpotMarketMeta } from "../src/rebalancer/adapters/binance";
import { ethers, expect, sinon } from "./utils";

describe("Binance adapter helpers", async function () {
  afterEach(function () {
    sinon.restore();
  });

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

  it("retries exchangeInfo lookups after transient failures", async function () {
    const adapter = await makeAdapter();
    const exchangeInfoStub = sinon.stub();
    exchangeInfoStub.onCall(0).rejects(new Error("temporary outage"));
    exchangeInfoStub.onCall(1).resolves({
      symbols: [{ symbol: "USDCUSDT", baseAsset: "USDC", quoteAsset: "USDT" }],
    });
    const symbolAdapter = adapter as unknown as {
      _getSymbol(sourceToken: string, destinationToken: string): Promise<{ symbol: string }>;
      binanceApiClient: { exchangeInfo: typeof exchangeInfoStub };
    };
    symbolAdapter.binanceApiClient = { exchangeInfo: exchangeInfoStub };

    try {
      await symbolAdapter._getSymbol("USDT", "USDC");
      expect.fail("expected the first _getSymbol call to propagate the exchangeInfo failure");
    } catch (error) {
      expect(String(error)).to.contain("temporary outage");
    }

    const symbol = await symbolAdapter._getSymbol("USDT", "USDC");

    expect(symbol.symbol).to.equal("USDCUSDT");
    expect(exchangeInfoStub.callCount).to.equal(2);
  });
});

async function makeAdapter(): Promise<BinanceStablecoinSwapAdapter> {
  const [signer] = await ethers.getSigners();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new BinanceStablecoinSwapAdapter(TEST_LOGGER, {} as any, signer, {} as any, {} as any);
}

const TEST_LOGGER = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

import { ethers, expect, sinon, toBNWei } from "./utils";
import {
  BinanceStablecoinSwapAdapter,
  convertBinanceRouteAmount,
  deriveBinanceSpotMarketMeta,
  isSameBinanceCoin,
  resolveBinanceCoinSymbol,
  supportsBinanceIntermediateBridgeToken,
} from "../src/rebalancer/adapters/binance";

describe("Binance adapter helpers", async function () {
  afterEach(function () {
    sinon.restore();
  });

  it("aliases on-chain WETH to Binance ETH", async function () {
    expect(resolveBinanceCoinSymbol("WETH")).to.equal("ETH");
    expect(resolveBinanceCoinSymbol("USDC")).to.equal("USDC");
  });

  it("detects same-coin Binance routes that should skip the swap leg", async function () {
    expect(isSameBinanceCoin("WETH", "WETH")).to.equal(true);
    expect(isSameBinanceCoin("USDC", "USDC")).to.equal(true);
    expect(isSameBinanceCoin("WETH", "USDC")).to.equal(false);
  });

  it("only permits intermediate Binance bridge legs for assets we can actually bridge onchain", async function () {
    expect(supportsBinanceIntermediateBridgeToken("USDC")).to.equal(true);
    expect(supportsBinanceIntermediateBridgeToken("USDT")).to.equal(true);
    expect(supportsBinanceIntermediateBridgeToken("WETH")).to.equal(false);
  });

  it("derives buy-side market metadata for USDT -> USDC routes", async function () {
    const meta = deriveBinanceSpotMarketMeta("USDT", "USDC", makeStablecoinSymbol() as never);

    expect(meta.symbol).to.equal("USDCUSDT");
    expect(meta.baseAssetName).to.equal("USDC");
    expect(meta.quoteAssetName).to.equal("USDT");
    expect(meta.pxDecimals).to.equal(4);
    expect(meta.szDecimals).to.equal(0);
    expect(meta.minimumOrderSize).to.equal(1);
    expect(meta.isBuy).to.equal(true);
  });

  it("derives sell-side market metadata for USDC -> USDT routes", async function () {
    const meta = deriveBinanceSpotMarketMeta("USDC", "USDT", makeStablecoinSymbol() as never);

    expect(meta.symbol).to.equal("USDCUSDT");
    expect(meta.baseAssetName).to.equal("USDC");
    expect(meta.quoteAssetName).to.equal("USDT");
    expect(meta.pxDecimals).to.equal(4);
    expect(meta.szDecimals).to.equal(0);
    expect(meta.minimumOrderSize).to.equal(1);
    expect(meta.isBuy).to.equal(false);
  });

  it("derives Binance spot market metadata for WETH/stable routes in both directions", async function () {
    const wethToUsdc = deriveBinanceSpotMarketMeta("WETH", "USDC", makeWethUsdcSymbol() as never);
    const usdcToWeth = deriveBinanceSpotMarketMeta("USDC", "WETH", makeWethUsdcSymbol() as never);

    expect(wethToUsdc.symbol).to.equal("ETHUSDC");
    expect(wethToUsdc.isBuy).to.equal(false);
    expect(wethToUsdc.pxDecimals).to.equal(2);
    expect(wethToUsdc.szDecimals).to.equal(4);
    expect(wethToUsdc.minimumOrderSize).to.equal(0.0001);
    expect(usdcToWeth.isBuy).to.equal(true);
  });

  it("converts non-parity Binance route amounts without assuming a 1:1 market", async function () {
    const oneWeth = toBNWei("1", 18);
    const fifteenHundredUsdc = convertBinanceRouteAmount({
      amount: oneWeth,
      sourceTokenDecimals: 18,
      destinationTokenDecimals: 6,
      isBuy: false,
      price: 1500,
      direction: "source-to-destination",
    });
    const sourceEquivalent = convertBinanceRouteAmount({
      amount: fifteenHundredUsdc,
      sourceTokenDecimals: 18,
      destinationTokenDecimals: 6,
      isBuy: false,
      price: 1500,
      direction: "destination-to-source",
    });

    expect(fifteenHundredUsdc.eq(toBNWei("1500", 6))).to.equal(true);
    expect(sourceEquivalent.eq(oneWeth)).to.equal(true);
  });

  it("retries tradeFee lookups after transient failures", async function () {
    const adapter = await makeAdapter();
    const tradeFeeStub = sinon.stub();
    tradeFeeStub.onCall(0).rejects(new Error("temporary outage"));
    tradeFeeStub.onCall(1).resolves([{ symbol: "USDCUSDT", takerCommission: "0.1" }]);
    const feeAdapter = adapter as unknown as {
      _getTradeFees(): Promise<Array<{ symbol: string; takerCommission: string }>>;
      binanceApiClient: { tradeFee: typeof tradeFeeStub };
    };
    feeAdapter.binanceApiClient = { tradeFee: tradeFeeStub };

    try {
      await feeAdapter._getTradeFees();
      expect.fail("expected the first _getTradeFees call to propagate the tradeFee failure");
    } catch (error) {
      expect(String(error)).to.contain("temporary outage");
    }

    const fees = await feeAdapter._getTradeFees();

    expect(fees[0].symbol).to.equal("USDCUSDT");
    expect(tradeFeeStub.callCount).to.equal(2);
  });
});

async function makeAdapter(): Promise<BinanceStablecoinSwapAdapter> {
  const [signer] = await ethers.getSigners();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new BinanceStablecoinSwapAdapter(TEST_LOGGER, {} as any, signer, {} as any, {} as any);
}

function makeStablecoinSymbol() {
  return {
    symbol: "USDCUSDT",
    baseAsset: "USDC",
    quoteAsset: "USDT",
    filters: [
      { filterType: "PRICE_FILTER", tickSize: "0.00010000" },
      { filterType: "LOT_SIZE", stepSize: "1.00000000", minQty: "1.00000000" },
    ],
  } as const;
}

function makeWethUsdcSymbol() {
  return {
    symbol: "ETHUSDC",
    baseAsset: "ETH",
    quoteAsset: "USDC",
    filters: [
      { filterType: "PRICE_FILTER", tickSize: "0.01000000" },
      { filterType: "LOT_SIZE", stepSize: "0.00010000", minQty: "0.00010000" },
    ],
  } as const;
}

const TEST_LOGGER = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

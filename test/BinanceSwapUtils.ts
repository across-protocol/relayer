import { expect } from "./utils";
import { CHAIN_IDs, toBNWei } from "../src/utils";
import {
  convertBinanceRouteAmount,
  deriveBinanceSpotMarketMeta,
  getAtomicDepositorContracts,
  isFailedBinanceWithdrawal,
  isSameBinanceCoin,
  isTerminalBinanceWithdrawal,
  supportsBinanceIntermediateBridgeToken,
  usesBinanceAtomicDepositorTransfer,
} from "../src/utils/BinanceSwapUtils";

describe("BinanceSwapUtils", function () {
  it("treats Binance withdrawal failure states as failed", function () {
    expect(isFailedBinanceWithdrawal(1)).to.equal(true);
    expect(isFailedBinanceWithdrawal(3)).to.equal(true);
    expect(isFailedBinanceWithdrawal(5)).to.equal(true);
    expect(isFailedBinanceWithdrawal(0)).to.equal(false);
    expect(isFailedBinanceWithdrawal(2)).to.equal(false);
    expect(isFailedBinanceWithdrawal(4)).to.equal(false);
    expect(isFailedBinanceWithdrawal(6)).to.equal(false);
    expect(isFailedBinanceWithdrawal(undefined)).to.equal(false);
  });

  it("treats only terminal Binance withdrawal states as terminal", function () {
    expect(isTerminalBinanceWithdrawal(1)).to.equal(true);
    expect(isTerminalBinanceWithdrawal(3)).to.equal(true);
    expect(isTerminalBinanceWithdrawal(5)).to.equal(true);
    expect(isTerminalBinanceWithdrawal(6)).to.equal(true);
    expect(isTerminalBinanceWithdrawal(0)).to.equal(false);
    expect(isTerminalBinanceWithdrawal(2)).to.equal(false);
    expect(isTerminalBinanceWithdrawal(4)).to.equal(false);
    expect(isTerminalBinanceWithdrawal(undefined)).to.equal(false);
  });

  it("normalizes wrapped/native aliases when comparing Binance coins", function () {
    expect(isSameBinanceCoin("WETH", "ETH")).to.equal(true);
    expect(isSameBinanceCoin("USDC", "USDC")).to.equal(true);
    expect(isSameBinanceCoin("WETH", "USDC")).to.equal(false);
  });

  it("only supports Binance intermediate bridge legs for supported stablecoins", function () {
    expect(supportsBinanceIntermediateBridgeToken("USDC")).to.equal(true);
    expect(supportsBinanceIntermediateBridgeToken("USDT")).to.equal(true);
    expect(supportsBinanceIntermediateBridgeToken("WETH")).to.equal(false);
  });

  it("returns atomic depositor contracts for supported chains", function () {
    const contracts = getAtomicDepositorContracts(CHAIN_IDs.MAINNET);

    expect(contracts).to.not.equal(undefined);
    expect(contracts?.atomicDepositorAddress).to.be.a("string");
    expect(contracts?.transferProxyAddress).to.be.a("string");
    expect(Array.isArray(contracts?.atomicDepositorAbi)).to.equal(true);
    expect(Array.isArray(contracts?.transferProxyAbi)).to.equal(true);
  });

  it("only enables atomic depositor transfers for WETH on chains with contracts", function () {
    expect(usesBinanceAtomicDepositorTransfer("USDC", CHAIN_IDs.MAINNET)).to.equal(false);
    expect(usesBinanceAtomicDepositorTransfer("WETH", CHAIN_IDs.MAINNET)).to.equal(true);
  });

  it("derives buy-side market metadata for USDT -> USDC routes", function () {
    const meta = deriveBinanceSpotMarketMeta("USDT", "USDC", makeStablecoinSymbol() as never);

    expect(meta.symbol).to.equal("USDCUSDT");
    expect(meta.baseAssetName).to.equal("USDC");
    expect(meta.quoteAssetName).to.equal("USDT");
    expect(meta.pxDecimals).to.equal(4);
    expect(meta.szDecimals).to.equal(0);
    expect(meta.minimumOrderSize).to.equal(1);
    expect(meta.isBuy).to.equal(true);
  });

  it("derives sell-side market metadata for USDC -> USDT routes", function () {
    const meta = deriveBinanceSpotMarketMeta("USDC", "USDT", makeStablecoinSymbol() as never);

    expect(meta.symbol).to.equal("USDCUSDT");
    expect(meta.baseAssetName).to.equal("USDC");
    expect(meta.quoteAssetName).to.equal("USDT");
    expect(meta.pxDecimals).to.equal(4);
    expect(meta.szDecimals).to.equal(0);
    expect(meta.minimumOrderSize).to.equal(1);
    expect(meta.isBuy).to.equal(false);
  });

  it("derives WETH/ETH spot metadata in both directions", function () {
    const wethToUsdc = deriveBinanceSpotMarketMeta("WETH", "USDC", makeWethUsdcSymbol() as never);
    const usdcToWeth = deriveBinanceSpotMarketMeta("USDC", "WETH", makeWethUsdcSymbol() as never);

    expect(wethToUsdc.symbol).to.equal("ETHUSDC");
    expect(wethToUsdc.isBuy).to.equal(false);
    expect(wethToUsdc.pxDecimals).to.equal(2);
    expect(wethToUsdc.szDecimals).to.equal(4);
    expect(wethToUsdc.minimumOrderSize).to.equal(0.0001);
    expect(usdcToWeth.isBuy).to.equal(true);
  });

  it("converts route amounts in both directions without assuming parity", function () {
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

  it("uses deterministic truncation for high-precision route conversion outputs", function () {
    const convertedAmount = convertBinanceRouteAmount({
      amount: toBNWei("1.07", 18),
      sourceTokenDecimals: 18,
      destinationTokenDecimals: 8,
      isBuy: false,
      price: 2.5,
      direction: "source-to-destination",
    });

    expect(convertedAmount.eq(toBNWei("2.675", 8))).to.equal(true);
  });
});

function makeStablecoinSymbol() {
  return {
    symbol: "USDCUSDT",
    baseAsset: "USDC",
    quoteAsset: "USDT",
    filters: [
      { filterType: "PRICE_FILTER", tickSize: "0.0001" },
      { filterType: "LOT_SIZE", stepSize: "1", minQty: "1" },
    ],
  };
}

function makeWethUsdcSymbol() {
  return {
    symbol: "ETHUSDC",
    baseAsset: "ETH",
    quoteAsset: "USDC",
    filters: [
      { filterType: "PRICE_FILTER", tickSize: "0.01" },
      { filterType: "LOT_SIZE", stepSize: "0.0001", minQty: "0.0001" },
    ],
  };
}

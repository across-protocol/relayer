import { BigNumber } from "ethers";
import { expect, toBNWei } from "./utils";
import {
  convertBinanceRouteAmount,
  deriveBinanceSpotMarketMeta,
  resolveBinanceCoinSymbol,
} from "../src/rebalancer/adapters/binance";

describe("Binance adapter helpers", async function () {
  it("aliases on-chain WETH to Binance ETH", async function () {
    expect(resolveBinanceCoinSymbol("WETH")).to.equal("ETH");
    expect(resolveBinanceCoinSymbol("USDC")).to.equal("USDC");
  });

  it("derives Binance spot market metadata for WETH/stable routes in both directions", async function () {
    const ethUsdcSymbol = {
      symbol: "ETHUSDC",
      baseAsset: "ETH",
      quoteAsset: "USDC",
      filters: [
        { filterType: "PRICE_FILTER", tickSize: "0.01000000" },
        { filterType: "LOT_SIZE", stepSize: "0.00010000", minQty: "0.00010000" },
      ],
    } as const;

    const wethToUsdc = deriveBinanceSpotMarketMeta("WETH", "USDC", ethUsdcSymbol as never);
    const usdcToWeth = deriveBinanceSpotMarketMeta("USDC", "WETH", ethUsdcSymbol as never);

    expect(wethToUsdc.symbol).to.equal("ETHUSDC");
    expect(wethToUsdc.isBuy).to.equal(false);
    expect(wethToUsdc.pxDecimals).to.equal(2);
    expect(wethToUsdc.szDecimals).to.equal(4);
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
    expect(sourceEquivalent.eq(BigNumber.from(oneWeth.toString()))).to.equal(true);
  });
});

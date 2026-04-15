import { ethers, expect, sinon, toBNWei } from "./utils";
import winston from "winston";
import {
  BinanceStablecoinSwapAdapter,
  convertBinanceRouteAmount,
  deriveBinanceSpotMarketMeta,
  isSameBinanceCoin,
  resolveBinanceCoinSymbol,
  supportsBinanceIntermediateBridgeToken,
} from "../src/rebalancer/adapters/binance";
import { CctpAdapter } from "../src/rebalancer/adapters/cctpAdapter";
import { OftAdapter } from "../src/rebalancer/adapters/oftAdapter";
import { RebalancerConfig } from "../src/rebalancer/RebalancerConfig";
import { CHAIN_IDs, EvmAddress } from "../src/utils";

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

  it("retries exchangeInfo lookups after transient failures", async function () {
    const adapter = await makeAdapter();
    const exchangeInfoStub = sinon.stub();
    exchangeInfoStub.onCall(0).rejects(new Error("temporary outage"));
    exchangeInfoStub.onCall(1).resolves({
      symbols: [{ ...makeStablecoinSymbol() }],
    });
    const symbolAdapter = adapter as unknown as {
      _getSymbol(sourceToken: string, destinationToken: string): Promise<{ symbol: string }>;
      binanceApiClient: { exchangeInfo: typeof exchangeInfoStub };
      exchangeInfoPromise?: Promise<unknown>;
    };
    symbolAdapter.binanceApiClient = { exchangeInfo: exchangeInfoStub };
    symbolAdapter.exchangeInfoPromise = undefined;

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

  it("keeps pending WETH credit until a finalized Binance withdrawal is wrapped", async function () {
    const adapter = await makeAdapter();
    const [signer] = await ethers.getSigners();
    const adapterWithInternals = adapter as unknown as {
      initialized: boolean;
      _redisGetPendingBridgesPreDeposit(account: EvmAddress): Promise<string[]>;
      _redisGetPendingOrders(account: EvmAddress): Promise<string[]>;
      _redisGetPendingWithdrawals(account: EvmAddress): Promise<string[]>;
      _redisGetOrderDetails(
        cloid: string,
        account: EvmAddress
      ): Promise<{
        sourceChain: number;
        sourceToken: string;
        destinationChain: number;
        destinationToken: string;
        amountToTransfer: ReturnType<typeof toBNWei>;
      }>;
      _getEntrypointNetwork(chainId: number, token: string): Promise<number>;
      _convertSourceToDestination(
        sourceToken: string,
        sourceChain: number,
        destinationToken: string,
        destinationChain: number,
        amount: ReturnType<typeof toBNWei>
      ): Promise<ReturnType<typeof toBNWei>>;
      _redisGetInitiatedWithdrawalId(cloid: string): Promise<string>;
      _getBinanceWithdrawals(
        token: string,
        network: number,
        since: number,
        account: string
      ): Promise<{
        unfinalizedWithdrawals: Array<{ id: string }>;
        finalizedWithdrawals: Array<{ id: string; amount: string }>;
      }>;
      _getTokenInfo(token: string, chainId: number): { decimals: number };
    };
    adapterWithInternals.initialized = true;

    const amount = toBNWei("1", 18);
    sinon.stub(adapterWithInternals, "_redisGetPendingBridgesPreDeposit").resolves([]);
    sinon.stub(adapterWithInternals, "_redisGetPendingOrders").resolves(["cloid"]);
    sinon.stub(adapterWithInternals, "_redisGetPendingWithdrawals").resolves(["cloid"]);
    sinon.stub(adapterWithInternals, "_redisGetOrderDetails").resolves({
      sourceChain: CHAIN_IDs.MAINNET,
      sourceToken: "WETH",
      destinationChain: CHAIN_IDs.MAINNET,
      destinationToken: "WETH",
      amountToTransfer: amount,
    });
    sinon.stub(adapterWithInternals, "_getEntrypointNetwork").resolves(CHAIN_IDs.MAINNET);
    sinon.stub(adapterWithInternals, "_convertSourceToDestination").resolves(amount);
    sinon.stub(adapterWithInternals, "_redisGetInitiatedWithdrawalId").resolves("withdrawal-id");
    sinon.stub(adapterWithInternals, "_getBinanceWithdrawals").resolves({
      unfinalizedWithdrawals: [],
      finalizedWithdrawals: [{ id: "withdrawal-id", amount: "1" }],
    });
    sinon.stub(adapterWithInternals, "_getTokenInfo").returns({ decimals: 18 });

    const pendingRebalances = await adapter.getPendingRebalances(EvmAddress.from(await signer.getAddress()));

    expect(pendingRebalances[CHAIN_IDs.MAINNET].WETH.eq(amount)).to.equal(true);
  });
});

async function makeAdapter(): Promise<BinanceStablecoinSwapAdapter> {
  const [signer] = await ethers.getSigners();
  return new BinanceStablecoinSwapAdapter(
    TEST_LOGGER,
    {} as RebalancerConfig,
    signer,
    {} as CctpAdapter,
    {} as OftAdapter
  );
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
} as unknown as winston.Logger;

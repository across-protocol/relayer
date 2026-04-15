import { CHAIN_IDs } from "@across-protocol/constants";
import winston from "winston";
import { ethers, expect, sinon, toBNWei } from "./utils";
import { BigNumber, EvmAddress } from "../src/utils";
import { BinanceStablecoinSwapAdapter } from "../src/rebalancer/adapters/binance";
import { CctpAdapter } from "../src/rebalancer/adapters/cctpAdapter";
import { OftAdapter } from "../src/rebalancer/adapters/oftAdapter";
import { RebalancerConfig } from "../src/rebalancer/RebalancerConfig";
import { RebalanceRoute } from "../src/rebalancer/utils/interfaces";

type BinanceCoinStub = {
  symbol?: string;
  balance?: string;
  networkList: Array<{
    name: string;
    withdrawMin: string;
    withdrawMax: string;
    withdrawFee: string;
  }>;
};

type BinanceTradeFeeStub = { symbol: string; takerCommission: string };

type IntermediateAdapterStub = Partial<Pick<CctpAdapter, "supportsRoute" | "getEstimatedCost">>;

type BinanceAdapterInternals = BinanceStablecoinSwapAdapter & {
  initialized: boolean;
  availableRoutes: RebalanceRoute[];
  baseSignerAddress: EvmAddress;
  _getSpotMarketMetaForRoute: (
    sourceToken: string,
    destinationToken: string
  ) => Promise<ReturnType<typeof makeSpotMeta>>;
  _getLatestPrice: (
    sourceToken: string,
    destinationToken: string,
    sourceChain: number,
    amountToTransfer: BigNumber
  ) => Promise<{ latestPrice: number; slippagePct: number }>;
  _getAccountCoins: (token: string) => Promise<BinanceCoinStub>;
  _getEntrypointNetwork: (chainId: number, token: string) => Promise<number>;
  _redisGetNextCloid: () => Promise<string>;
  _depositToBinance: (sourceToken: string, sourceChain: number, amountToDeposit: BigNumber) => Promise<void>;
  _redisCreateOrder: (
    cloid: string,
    status: number,
    rebalanceRoute: RebalanceRoute,
    amountToTransfer: BigNumber,
    account: EvmAddress,
    ttlOverride?: number
  ) => Promise<void>;
  _getTradeFees: () => Promise<BinanceTradeFeeStub[]>;
  _getTokenPriceUsd: (token: string) => Promise<BigNumber>;
  _convertDestinationToSource: (
    destinationToken: string,
    destinationChain: number,
    sourceToken: string,
    sourceChain: number,
    destinationAmount: BigNumber
  ) => Promise<BigNumber>;
};

function withBinanceInternals(adapter: BinanceStablecoinSwapAdapter): BinanceAdapterInternals {
  return adapter as unknown as BinanceAdapterInternals;
}

describe("Binance adapter conversion sizing", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("uses converted withdrawal minimums when deciding whether to initialize a rebalance", async function () {
    const route = makeStablecoinRoute();
    const adapter = await makeInitializedAdapter(route);
    const internals = withBinanceInternals(adapter);
    const depositStub = sinon.stub();
    const createOrderStub = sinon.stub().resolves();
    sinon.stub(adapter, "getEstimatedCost").resolves(toBNWei("0", 6));
    sinon.stub(internals, "_getSpotMarketMetaForRoute").resolves(makeSpotMeta(true, 1));
    sinon.stub(internals, "_getLatestPrice").resolves({ latestPrice: 0.99, slippagePct: 0 });
    sinon.stub(internals, "_getAccountCoins").resolves(makeCoin("100", "1000000"));
    sinon.stub(internals, "_getEntrypointNetwork").callsFake(async () => CHAIN_IDs.MAINNET);
    sinon.stub(internals, "_redisGetNextCloid").resolves("cloid");
    sinon.stub(internals, "_depositToBinance").callsFake(depositStub);
    sinon.stub(internals, "_redisCreateOrder").callsFake(createOrderStub);

    const amount = toBNWei("100", 6);
    const result = await adapter.initializeRebalance(route, amount);

    expect(result.eq(amount)).to.equal(true);
    expect(depositStub.calledOnce).to.equal(true);
    expect(createOrderStub.calledOnce).to.equal(true);
  });

  it("uses converted buy-side minimum order sizes", async function () {
    const route = makeStablecoinRoute();
    const adapter = await makeInitializedAdapter(route);
    const internals = withBinanceInternals(adapter);
    const depositStub = sinon.stub();
    const createOrderStub = sinon.stub().resolves();
    sinon.stub(adapter, "getEstimatedCost").resolves(toBNWei("0", 6));
    sinon.stub(internals, "_getSpotMarketMetaForRoute").resolves(makeSpotMeta(true, 100));
    sinon.stub(internals, "_getLatestPrice").resolves({ latestPrice: 0.99, slippagePct: 0 });
    sinon.stub(internals, "_getAccountCoins").resolves(makeCoin("0", "1000000"));
    sinon.stub(internals, "_getEntrypointNetwork").callsFake(async () => CHAIN_IDs.MAINNET);
    sinon.stub(internals, "_redisGetNextCloid").resolves("cloid");
    sinon.stub(internals, "_depositToBinance").callsFake(depositStub);
    sinon.stub(internals, "_redisCreateOrder").callsFake(createOrderStub);

    const amount = toBNWei("99.5", 6);
    const result = await adapter.initializeRebalance(route, amount);

    expect(result.eq(amount)).to.equal(true);
    expect(depositStub.calledOnce).to.equal(true);
    expect(createOrderStub.calledOnce).to.equal(true);
  });

  it("prices downstream bridge fees using destination-token amounts", async function () {
    const route = makeStablecoinRoute({ destinationChain: CHAIN_IDs.BASE });
    const cctpGetEstimatedCost = sinon.stub().resolves(toBNWei("0", 6));
    const adapter = await makeInitializedAdapter(route, {
      cctpAdapter: {
        supportsRoute: sinon.stub().returns(true),
        getEstimatedCost: cctpGetEstimatedCost,
      },
    });
    const internals = withBinanceInternals(adapter);

    sinon.stub(internals, "_getSpotMarketMetaForRoute").resolves(makeSpotMeta(true, 1));
    sinon.stub(internals, "_getLatestPrice").resolves({ latestPrice: 0.98, slippagePct: 0 });
    sinon.stub(internals, "_getAccountCoins").resolves(makeCoin("0", "1000000"));
    sinon.stub(internals, "_getTradeFees").resolves([{ symbol: "USDCUSDT", takerCommission: "0" }]);
    sinon.stub(internals, "_getTokenPriceUsd").callsFake(async () => toBNWei("1"));
    sinon.stub(internals, "_getEntrypointNetwork").callsFake(async (...args: [number, string]) => {
      const [chainId, token] = args;
      return token === "USDC" && chainId === CHAIN_IDs.BASE ? CHAIN_IDs.MAINNET : chainId;
    });

    await adapter.getEstimatedCost(route, toBNWei("100", 6), false);

    expect(cctpGetEstimatedCost.calledOnce).to.equal(true);
    expect(cctpGetEstimatedCost.getCall(0).args[1].eq(toBNWei("102.040816", 6))).to.equal(true);
  });

  it("does not inflate stablecoin withdrawal fees when source and destination decimals differ", async function () {
    const route = makeStablecoinRoute({ sourceChain: CHAIN_IDs.BSC, destinationChain: CHAIN_IDs.BASE });
    const adapter = await makeInitializedAdapter(route);
    const internals = withBinanceInternals(adapter);

    sinon.stub(internals, "_getSpotMarketMetaForRoute").resolves(makeSpotMeta(true, 1));
    sinon.stub(internals, "_getTradeFees").resolves([{ symbol: "USDCUSDT", takerCommission: "0" }]);
    sinon.stub(internals, "_getLatestPrice").resolves({ latestPrice: 1, slippagePct: 0 });
    sinon.stub(internals, "_getTokenPriceUsd").callsFake(async () => toBNWei("1"));
    sinon.stub(internals, "_getAccountCoins").callsFake(async (token: string) => {
      return {
        symbol: token,
        balance: "0",
        networkList: [
          {
            name: "BASE",
            withdrawMin: "0.1",
            withdrawMax: "1000000",
            withdrawFee: "0.499695",
          },
          {
            name: "BSC",
            withdrawMin: "0.1",
            withdrawMax: "1000000",
            withdrawFee: "0",
          },
        ],
      };
    });
    sinon.stub(internals, "_getEntrypointNetwork").callsFake(async (chainId: number) => chainId);

    const cost = await adapter.getEstimatedCost(route, toBNWei("308304.851912549672926661", 18), false);

    expect(cost.eq(toBNWei("0.499695", 18))).to.equal(true);
  });

  it("prices mixed-asset execution against oracle value, not just book slippage", async function () {
    const route = makeStablecoinRoute({ sourceToken: "USDC", destinationToken: "WETH" });
    const adapter = await makeInitializedAdapter(route);
    const internals = withBinanceInternals(adapter);

    sinon.stub(internals, "_getSpotMarketMetaForRoute").resolves(makeEthUsdcSpotMeta(true, 0.0001));
    sinon.stub(internals, "_getTradeFees").resolves([{ symbol: "ETHUSDC", takerCommission: "0" }]);
    sinon.stub(internals, "_getLatestPrice").resolves({ latestPrice: 2200, slippagePct: 0 });
    sinon.stub(internals, "_getAccountCoins").resolves(makeCoin("0", "1000000"));
    sinon.stub(internals, "_getEntrypointNetwork").callsFake(async (chainId: number) => chainId);
    sinon.stub(internals, "_getTokenPriceUsd").callsFake(async (token: string) => {
      return token === "WETH" ? toBNWei("2000") : toBNWei("1");
    });

    const cost = await adapter.getEstimatedCost(route, toBNWei("2200", 6), false);

    expect(cost.eq(toBNWei("200", 6))).to.equal(true);
  });

  it("prices destination-to-source conversions using source-token precision", async function () {
    const route = makeStablecoinRoute();
    const adapter = await makeInitializedAdapter(route);
    const internals = withBinanceInternals(adapter);
    const latestPriceStub = sinon.stub().resolves({ latestPrice: 2500, slippagePct: 0 });
    sinon.stub(internals, "_getSpotMarketMetaForRoute").resolves(makeSpotMeta(true, 1));
    sinon.stub(internals, "_getLatestPrice").callsFake(latestPriceStub);

    await internals._convertDestinationToSource("WETH", CHAIN_IDs.MAINNET, "USDC", CHAIN_IDs.MAINNET, toBNWei("1", 18));

    expect(latestPriceStub.calledOnce).to.equal(true);
    expect(latestPriceStub.getCall(0).args[0]).to.equal("USDC");
    expect(latestPriceStub.getCall(0).args[1]).to.equal("WETH");
    expect(latestPriceStub.getCall(0).args[2]).to.equal(CHAIN_IDs.MAINNET);
    expect(latestPriceStub.getCall(0).args[3].eq(toBNWei("1", 6))).to.equal(true);
  });
});

async function makeInitializedAdapter(
  route: RebalanceRoute,
  {
    cctpAdapter = {},
    oftAdapter = {},
  }: {
    cctpAdapter?: IntermediateAdapterStub;
    oftAdapter?: IntermediateAdapterStub;
  } = {}
): Promise<BinanceStablecoinSwapAdapter> {
  const [signer] = await ethers.getSigners();
  const adapter = new BinanceStablecoinSwapAdapter(
    TEST_LOGGER,
    { hubPoolChainId: CHAIN_IDs.MAINNET } as RebalancerConfig,
    signer,
    cctpAdapter as CctpAdapter,
    oftAdapter as OftAdapter
  );
  const internals = withBinanceInternals(adapter);
  internals.initialized = true;
  internals.availableRoutes = [route];
  internals.baseSignerAddress = EvmAddress.from(await signer.getAddress());
  return adapter;
}

function makeStablecoinRoute(overrides: Partial<RebalanceRoute> = {}): RebalanceRoute {
  return {
    sourceChain: CHAIN_IDs.MAINNET,
    destinationChain: CHAIN_IDs.MAINNET,
    sourceToken: "USDT",
    destinationToken: "USDC",
    adapter: "binance",
    ...overrides,
  };
}

function makeSpotMeta(isBuy: boolean, minimumOrderSize: number) {
  return {
    symbol: "USDCUSDT",
    baseAssetName: "USDC",
    quoteAssetName: "USDT",
    pxDecimals: 4,
    szDecimals: 0,
    minimumOrderSize,
    isBuy,
  };
}

function makeEthUsdcSpotMeta(isBuy: boolean, minimumOrderSize: number) {
  return {
    symbol: "ETHUSDC",
    baseAssetName: "ETH",
    quoteAssetName: "USDC",
    pxDecimals: 2,
    szDecimals: 4,
    minimumOrderSize,
    isBuy,
  };
}

function makeCoin(withdrawMin: string, withdrawMax: string) {
  return {
    networkList: [{ name: "ETH", withdrawMin, withdrawMax, withdrawFee: "0" }],
  };
}

const TEST_LOGGER = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as winston.Logger;

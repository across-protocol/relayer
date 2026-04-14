import { CHAIN_IDs } from "@across-protocol/constants";
import { ethers, expect, sinon, toBNWei } from "./utils";
import { EvmAddress } from "../src/utils";
import { BinanceStablecoinSwapAdapter } from "../src/rebalancer/adapters/binance";
import { RebalanceRoute } from "../src/rebalancer/utils/interfaces";

describe("Binance adapter conversion sizing", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("uses converted withdrawal minimums when deciding whether to initialize a rebalance", async function () {
    const route = makeStablecoinRoute();
    const adapter = await makeInitializedAdapter(route);
    const depositStub = sinon.stub();
    const createOrderStub = sinon.stub().resolves();
    sinon.stub(adapter, "getEstimatedCost").resolves(toBNWei("0", 6));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sinon.stub(adapter as any, "_getSpotMarketMetaForRoute").resolves(makeSpotMeta(true, 1));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sinon.stub(adapter as any, "_getLatestPrice").resolves({ latestPrice: 0.99, slippagePct: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sinon.stub(adapter as any, "_getAccountCoins").resolves(makeCoin("100", "1000000"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sinon.stub(adapter as any, "_getEntrypointNetwork").callsFake(async () => CHAIN_IDs.MAINNET);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sinon.stub(adapter as any, "_redisGetNextCloid").resolves("cloid");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sinon.stub(adapter as any, "_depositToBinance").callsFake(depositStub);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sinon.stub(adapter as any, "_redisCreateOrder").callsFake(createOrderStub);

    const amount = toBNWei("100", 6);
    const result = await adapter.initializeRebalance(route, amount);

    expect(result.eq(amount)).to.equal(true);
    expect(depositStub.calledOnce).to.equal(true);
    expect(createOrderStub.calledOnce).to.equal(true);
  });

  it("uses converted buy-side minimum order sizes", async function () {
    const route = makeStablecoinRoute();
    const adapter = await makeInitializedAdapter(route);
    const depositStub = sinon.stub();
    const createOrderStub = sinon.stub().resolves();
    sinon.stub(adapter, "getEstimatedCost").resolves(toBNWei("0", 6));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sinon.stub(adapter as any, "_getSpotMarketMetaForRoute").resolves(makeSpotMeta(true, 100));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sinon.stub(adapter as any, "_getLatestPrice").resolves({ latestPrice: 0.99, slippagePct: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sinon.stub(adapter as any, "_getAccountCoins").resolves(makeCoin("0", "1000000"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sinon.stub(adapter as any, "_getEntrypointNetwork").callsFake(async () => CHAIN_IDs.MAINNET);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sinon.stub(adapter as any, "_redisGetNextCloid").resolves("cloid");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sinon.stub(adapter as any, "_depositToBinance").callsFake(depositStub);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sinon.stub(adapter as any, "_redisCreateOrder").callsFake(createOrderStub);

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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sinon.stub(adapter as any, "_getSpotMarketMetaForRoute").resolves(makeSpotMeta(true, 1));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sinon.stub(adapter as any, "_getLatestPrice").resolves({ latestPrice: 0.98, slippagePct: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sinon.stub(adapter as any, "_getAccountCoins").resolves(makeCoin("0", "1000000"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sinon.stub(adapter as any, "_getTradeFees").resolves([{ symbol: "USDCUSDT", takerCommission: "0" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sinon.stub(adapter as any, "_getEntrypointNetwork").callsFake(async (...args: [number, string]) => {
      const [chainId, token] = args;
      return token === "USDC" && chainId === CHAIN_IDs.BASE ? CHAIN_IDs.MAINNET : chainId;
    });

    await adapter.getEstimatedCost(route, toBNWei("100", 6), false);

    expect(cctpGetEstimatedCost.calledOnce).to.equal(true);
    expect(cctpGetEstimatedCost.getCall(0).args[1].eq(toBNWei("102.040816", 6))).to.equal(true);
  });

  it("prices destination-to-source conversions using source-token precision", async function () {
    const route = makeStablecoinRoute();
    const adapter = await makeInitializedAdapter(route);
    const latestPriceStub = sinon.stub().resolves({ latestPrice: 2500, slippagePct: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sinon.stub(adapter as any, "_getSpotMarketMetaForRoute").resolves(makeSpotMeta(true, 1));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sinon.stub(adapter as any, "_getLatestPrice").callsFake(latestPriceStub);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (adapter as any)._convertDestinationToSource(
      "WETH",
      CHAIN_IDs.MAINNET,
      "USDC",
      CHAIN_IDs.MAINNET,
      toBNWei("1", 18)
    );

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cctpAdapter?: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    oftAdapter?: any;
  } = {}
): Promise<BinanceStablecoinSwapAdapter> {
  const [signer] = await ethers.getSigners();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter = new BinanceStablecoinSwapAdapter(TEST_LOGGER, {} as any, signer, cctpAdapter, oftAdapter);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).initialized = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).availableRoutes = [route];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).baseSignerAddress = EvmAddress.from(await signer.getAddress());
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

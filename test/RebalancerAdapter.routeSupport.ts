import { expect, ethers, sinon } from "./utils";
import winston from "winston";
import { HyperliquidStablecoinSwapAdapter } from "../src/rebalancer/adapters/hyperliquid";
import { CctpAdapter } from "../src/rebalancer/adapters/cctpAdapter";
import { OftAdapter } from "../src/rebalancer/adapters/oftAdapter";
import { RebalancerConfig } from "../src/rebalancer/RebalancerConfig";
import { RebalanceRoute, OrderDetails } from "../src/rebalancer/utils/interfaces";
import { BigNumber, bnZero, CHAIN_IDs, EvmAddress, toBNWei } from "../src/utils";

const TEST_LOGGER = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as winston.Logger;

// A pending order created by the swap rebalancer: swap USDT on Arbitrum into USDC on Mainnet via Hyperliquid.
// Progressing its final leg requires a CCTP bridge from HyperEVM to Mainnet.
const SWAP_ORDER_DETAILS: OrderDetails = {
  sourceToken: "USDT",
  sourceChain: CHAIN_IDs.ARBITRUM,
  destinationToken: "USDC",
  destinationChain: CHAIN_IDs.MAINNET,
  amountToTransfer: toBNWei("100", 6),
};

const SWAP_ORDER_ROUTE: RebalanceRoute = {
  sourceChain: SWAP_ORDER_DETAILS.sourceChain,
  sourceToken: SWAP_ORDER_DETAILS.sourceToken,
  destinationChain: SWAP_ORDER_DETAILS.destinationChain,
  destinationToken: SWAP_ORDER_DETAILS.destinationToken,
  adapter: "hyperliquid",
};

type AdapterInternals = {
  initialized: boolean;
  availableRoutes: RebalanceRoute[];
  _redisGetPendingBridgesPreDeposit(account: EvmAddress): Promise<string[]>;
  _redisGetPendingDeposits(account: EvmAddress): Promise<string[]>;
  _redisGetPendingSwaps(account: EvmAddress): Promise<string[]>;
  _redisGetPendingWithdrawals(account: EvmAddress): Promise<string[]>;
  _redisGetOrderDetails(cloid: string, account: EvmAddress): Promise<OrderDetails | undefined>;
  _getERC20Balance(chainId: number, tokenAddress: string, account: EvmAddress): Promise<BigNumber>;
  _depositToHypercore(sourceToken: string, amount: BigNumber): Promise<void>;
  _createHlOrder(orderDetails: OrderDetails, cloid: string): Promise<unknown>;
  _getMatchingFillForCloid(account: EvmAddress, cloid: string): Promise<unknown>;
  _bridgeToChain(token: string, originChain: number, destinationChain: number, amount: BigNumber): Promise<BigNumber>;
};

async function makeHyperliquidAdapter(): Promise<{
  adapter: HyperliquidStablecoinSwapAdapter;
  internals: AdapterInternals;
}> {
  const wallet = ethers.Wallet.createRandom();
  const adapter = new HyperliquidStablecoinSwapAdapter(
    TEST_LOGGER,
    {} as RebalancerConfig,
    wallet,
    {} as CctpAdapter,
    {} as OftAdapter
  );
  const internals = adapter as unknown as AdapterInternals;
  internals.initialized = true;
  adapter.baseSignerAddress = EvmAddress.from(await wallet.getAddress());
  return { adapter, internals };
}

describe("Rebalancer adapters only progress orders for supported routes", function () {
  afterEach(function () {
    sinon.restore();
  });

  // Multiple rebalancer bots (e.g. swapRebalancer and sameAssetRebalancer) share a signer and Redis order store, so
  // an adapter can encounter pending orders created by a bot with a different route catalog. Regression test for the
  // sameAssetRebalancer crashing with "Route is not supported: USDC 999 -> USDC 1" while progressing a swap-created
  // Hyperliquid order through its final CCTP bridge leg.
  it("skips pending orders whose routes are not in availableRoutes without throwing", async function () {
    const { adapter, internals } = await makeHyperliquidAdapter();
    expect(internals.availableRoutes).to.deep.equal([]);

    sinon.stub(internals, "_redisGetPendingBridgesPreDeposit").resolves(["cloid-bridge"]);
    sinon.stub(internals, "_redisGetPendingDeposits").resolves(["cloid-deposit"]);
    // Keep pending swaps empty so the pre-loop open-orders API lookup is not triggered.
    sinon.stub(internals, "_redisGetPendingSwaps").resolves([]);
    sinon.stub(internals, "_redisGetPendingWithdrawals").resolves(["cloid-withdrawal"]);
    sinon.stub(internals, "_redisGetOrderDetails").resolves(SWAP_ORDER_DETAILS);

    const depositToHypercore = sinon.stub(internals, "_depositToHypercore").resolves();
    const createHlOrder = sinon.stub(internals, "_createHlOrder").resolves(undefined);
    const getMatchingFill = sinon.stub(internals, "_getMatchingFillForCloid").resolves(undefined);
    const bridgeToChain = sinon.stub(internals, "_bridgeToChain").resolves(bnZero);
    const getBalance = sinon.stub(internals, "_getERC20Balance").resolves(bnZero);

    await adapter.updateRebalanceStatuses();

    expect(getBalance.called).to.equal(false);
    expect(depositToHypercore.called).to.equal(false);
    expect(createHlOrder.called).to.equal(false);
    expect(getMatchingFill.called).to.equal(false);
    expect(bridgeToChain.called).to.equal(false);
  });

  it("progresses pending orders whose routes are in availableRoutes", async function () {
    const { adapter, internals } = await makeHyperliquidAdapter();
    internals.availableRoutes = [SWAP_ORDER_ROUTE];

    sinon.stub(internals, "_redisGetPendingBridgesPreDeposit").resolves(["cloid-bridge"]);
    sinon.stub(internals, "_redisGetPendingDeposits").resolves([]);
    sinon.stub(internals, "_redisGetPendingSwaps").resolves([]);
    sinon.stub(internals, "_redisGetPendingWithdrawals").resolves([]);
    sinon.stub(internals, "_redisGetOrderDetails").resolves(SWAP_ORDER_DETAILS);
    // Report insufficient HyperEVM balance so the order is left pending after the route-support gate.
    const getBalance = sinon.stub(internals, "_getERC20Balance").resolves(bnZero);
    const depositToHypercore = sinon.stub(internals, "_depositToHypercore").resolves();

    await adapter.updateRebalanceStatuses();

    expect(getBalance.called).to.equal(true);
    expect(depositToHypercore.called).to.equal(false);
  });

  it("supportsRoute accepts pending order details without an adapter name", async function () {
    const { adapter, internals } = await makeHyperliquidAdapter();
    expect(adapter.supportsRoute(SWAP_ORDER_DETAILS)).to.equal(false);
    internals.availableRoutes = [SWAP_ORDER_ROUTE];
    expect(adapter.supportsRoute(SWAP_ORDER_DETAILS)).to.equal(true);
  });
});

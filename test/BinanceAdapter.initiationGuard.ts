import { ethers, expect, sinon, toBNWei } from "./utils";
import winston from "winston";
import { BinanceStablecoinSwapAdapter } from "../src/rebalancer/adapters/binance";
import { CctpAdapter } from "../src/rebalancer/adapters/cctpAdapter";
import { OftAdapter } from "../src/rebalancer/adapters/oftAdapter";
import { RebalancerConfig } from "../src/rebalancer/RebalancerConfig";
import { RebalanceRoute } from "../src/rebalancer/utils/interfaces";
import { BINANCE_NETWORKS, BigNumber, CHAIN_IDs, EvmAddress, TOKEN_SYMBOLS_MAP, bnZero } from "../src/utils";

const TEST_LOGGER = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as winston.Logger;

const ROUTE: RebalanceRoute = {
  sourceChain: CHAIN_IDs.MAINNET,
  sourceToken: "USDT",
  destinationChain: CHAIN_IDs.AVALANCHE,
  destinationToken: "USDT",
  adapter: "binance",
};

type AdapterInternals = {
  initialized: boolean;
  availableRoutes: RebalanceRoute[];
  initializeRebalance(route: RebalanceRoute, amountToTransfer: BigNumber): Promise<BigNumber>;
  _routeRequiresSwap(sourceToken: string, destinationToken: string): boolean;
  _getAccountCoins(symbol: string, skipCache?: boolean): Promise<unknown>;
  _getEntrypointNetwork(chainId: number, token?: string): Promise<number>;
  _getBridgingFees(route: unknown, amountToTransfer: BigNumber): Promise<BigNumber>;
  _convertSourceToDestination(...args: unknown[]): Promise<BigNumber>;
  _redisGetNextCloid(): Promise<string>;
  _depositToBinance(cloid: string, token: string, chainId: number, amount: BigNumber): Promise<void>;
  _redisCreateOrder(...args: unknown[]): Promise<void>;
  _redisGetOrderDetails(cloid: string, account: EvmAddress): Promise<unknown>;
};

// An in-memory Redis shared between adapter instances, with SET NX lock semantics.
function makeRedis() {
  const locks = new Map<string, string>();
  return {
    locks,
    acquireLock: async (key: string, token: string) => {
      if (locks.has(key)) {
        return false;
      }
      locks.set(key, token);
      return true;
    },
    releaseLock: async (key: string, token: string) => {
      if (locks.get(key) !== token) {
        return false;
      }
      return locks.delete(key);
    },
    get: async () => undefined,
    set: async () => "OK",
    del: async () => 1,
    sMembers: async () => [],
    sAdd: async () => 1,
    sRem: async () => 1,
  };
}

describe("Binance adapter initiation collision guard", function () {
  afterEach(function () {
    sinon.restore();
  });

  let nextCloid = 0;

  async function makeAdapter(redis: ReturnType<typeof makeRedis>, options: { pendingRoutes?: RebalanceRoute[] } = {}) {
    const [signer] = await ethers.getSigners();
    const adapter = new BinanceStablecoinSwapAdapter(
      TEST_LOGGER,
      {} as RebalancerConfig,
      signer,
      {} as CctpAdapter,
      {} as OftAdapter
    );
    const internals = adapter as unknown as AdapterInternals;
    internals.initialized = true;
    internals.availableRoutes = [ROUTE];
    adapter.baseSignerAddress = EvmAddress.from(signer.address);
    Object.assign(adapter, { _redisCache: redis });

    sinon.stub(internals, "_routeRequiresSwap").returns(false);
    sinon.stub(internals, "_getEntrypointNetwork").callsFake(async (chainId) => chainId);
    sinon.stub(internals, "_getAccountCoins").resolves({
      symbol: "USDT",
      balance: "0",
      networkList: [
        {
          name: BINANCE_NETWORKS[CHAIN_IDs.AVALANCHE],
          coin: "USDT",
          withdrawMin: "1",
          withdrawMax: "1000000",
          withdrawFee: "0",
          contractAddress: TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.AVALANCHE],
          withdrawEnable: true,
        },
      ],
    });
    sinon.stub(internals, "_getBridgingFees").resolves(bnZero);
    sinon.stub(internals, "_convertSourceToDestination").callsFake(async (...args) => args[4] as BigNumber);
    sinon.stub(internals, "_redisGetNextCloid").callsFake(async () => `cloid-${nextCloid++}`);
    const pendingRoutes = options.pendingRoutes ?? [];
    sinon.stub(adapter, "getPendingOrders").resolves(pendingRoutes.map((_route, index) => `pending-${index}`));
    sinon.stub(internals, "_redisGetOrderDetails").callsFake(async (cloid: string) => ({
      ...pendingRoutes[Number(cloid.split("-")[1])],
      amountToTransfer: toBNWei("100", 6),
    }));
    const createOrder = sinon.stub(internals, "_redisCreateOrder").resolves();
    const deposit = sinon.stub(internals, "_depositToBinance").resolves();
    return { adapter, internals, createOrder, deposit };
  }

  it("declines the second concurrent same-route initiation", async function () {
    const redis = makeRedis();
    const first = await makeAdapter(redis);
    const second = await makeAdapter(redis);
    const amount = toBNWei("6000", 6);

    // Hold the guard mid-initiation by blocking the first adapter's deposit.
    let releaseDeposit!: () => void;
    first.deposit.callsFake(() => new Promise<void>((resolve) => (releaseDeposit = () => resolve())));
    const firstInitiation = first.internals.initializeRebalance(ROUTE, amount);
    await new Promise((resolve) => setImmediate(resolve));

    // The second initiator is declined while the guard is held, without touching Binance.
    expect((await second.internals.initializeRebalance(ROUTE, amount)).eq(bnZero)).to.equal(true);
    expect(second.deposit.called).to.equal(false);

    releaseDeposit();
    expect((await firstInitiation).eq(amount)).to.equal(true);
    expect(first.createOrder.calledOnce).to.equal(true);

    // The guard is released after initiation completes, so a later run can initiate again.
    expect(redis.locks.size).to.equal(0);
    expect((await second.internals.initializeRebalance(ROUTE, amount)).eq(amount)).to.equal(true);
  });

  it("declines re-initiating a route that already has a pending order", async function () {
    const redis = makeRedis();
    const { internals, deposit } = await makeAdapter(redis, { pendingRoutes: [ROUTE] });

    expect((await internals.initializeRebalance(ROUTE, toBNWei("6000", 6))).eq(bnZero)).to.equal(true);
    expect(deposit.called).to.equal(false);
    // The duplicate decline releases the guard for other routes and later runs.
    expect(redis.locks.size).to.equal(0);
  });

  it("releases the guard when initiation fails", async function () {
    const redis = makeRedis();
    const { internals, deposit } = await makeAdapter(redis);
    deposit.rejects(new Error("submission failed"));

    await expect(internals.initializeRebalance(ROUTE, toBNWei("6000", 6))).to.be.rejectedWith("submission failed");
    expect(redis.locks.size).to.equal(0);
  });
});

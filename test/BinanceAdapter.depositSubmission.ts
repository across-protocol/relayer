import { ethers, expect, sinon, toBNWei } from "./utils";
import winston from "winston";
import { BinanceStablecoinSwapAdapter } from "../src/rebalancer/adapters/binance";
import { CctpAdapter } from "../src/rebalancer/adapters/cctpAdapter";
import { OftAdapter } from "../src/rebalancer/adapters/oftAdapter";
import { RebalancerConfig } from "../src/rebalancer/RebalancerConfig";
import { RebalanceRoute } from "../src/rebalancer/utils/interfaces";
import {
  STATUS,
  getPendingBridgeDepositRecoveryKey,
  getPendingBridgeDepositTxnKey,
} from "../src/rebalancer/utils/utils";
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
  REDIS_PREFIX: string;
  initializeRebalance(route: RebalanceRoute, amountToTransfer: BigNumber): Promise<BigNumber>;
  _assertInitialized(): void;
  _routeRequiresSwap(sourceToken: string, destinationToken: string): boolean;
  _getAccountCoins(symbol: string, skipCache?: boolean): Promise<unknown>;
  _getEntrypointNetwork(chainId: number, token?: string): Promise<number>;
  _getBridgingFees(route: unknown, amountToTransfer: BigNumber): Promise<BigNumber>;
  _convertSourceToDestination(...args: unknown[]): Promise<BigNumber>;
  _redisGetNextCloid(): Promise<string>;
  _depositToBinance(cloid: string, token: string, chainId: number, amount: BigNumber): Promise<void>;
  _redisCreateOrder(...args: unknown[]): Promise<void>;
  _redisUpdateOrderStatus(cloid: string, oldStatus: number, status: number, account: EvmAddress): Promise<void>;
  _redisDeleteOrder(cloid: string, currentStatus: number, account: EvmAddress): Promise<boolean>;
  _redisGetPendingDepositSubmissions(account: EvmAddress): Promise<string[]>;
  _redisGetPendingBridgesPreDeposit(account: EvmAddress): Promise<string[]>;
  _redisGetPendingDeposits(account: EvmAddress): Promise<string[]>;
  _redisGetPendingSwaps(account: EvmAddress): Promise<string[]>;
  _redisGetPendingWithdrawals(account: EvmAddress): Promise<string[]>;
  _redisGetOrderDetailsRequired(cloid: string, account: EvmAddress): Promise<unknown>;
  _reconcileDepositRecovery(cloid: string): Promise<void>;
  _getDepositTransactionReceipt(chainId: number, transactionHash: string): Promise<unknown>;
};

describe("Binance adapter crash-safe deposit submission", function () {
  afterEach(function () {
    sinon.restore();
  });

  async function makeAdapter() {
    const [signer] = await ethers.getSigners();
    const account = EvmAddress.from(signer.address);
    const values = new Map<string, string>();
    const redis = {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: string) => {
        values.set(key, value);
        return "OK";
      },
      del: async (key: string) => Number(values.delete(key)),
      sMembers: async () => [],
      sAdd: async () => 1,
      sRem: async () => 1,
    };
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
    adapter.baseSignerAddress = account;
    Object.assign(adapter, { _redisCache: redis });
    return { adapter, internals, account, values };
  }

  function stubDirectDepositPreflight(internals: AdapterInternals) {
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
    sinon.stub(internals, "_redisGetNextCloid").resolves("cloid-1");
  }

  it("persists the order and recovery marker before submitting a direct deposit, then promotes it", async function () {
    const { internals, account, values } = await makeAdapter();
    stubDirectDepositPreflight(internals);
    const recoveryKey = getPendingBridgeDepositRecoveryKey(internals.REDIS_PREFIX, "cloid-1", account.toNative());
    const createOrder = sinon.stub(internals, "_redisCreateOrder").resolves();
    const updateStatus = sinon.stub(internals, "_redisUpdateOrderStatus").resolves();
    const deposit = sinon.stub(internals, "_depositToBinance").callsFake(async () => {
      // The order and its recovery marker must exist before the deposit can broadcast.
      expect(createOrder.calledOnce).to.equal(true);
      expect(createOrder.firstCall.args[1]).to.equal(STATUS.PENDING_DEPOSIT_SUBMISSION);
      expect(values.has(recoveryKey)).to.equal(true);
    });

    const amount = toBNWei("6000", 6);
    expect((await internals.initializeRebalance(ROUTE, amount)).eq(amount)).to.equal(true);

    expect(deposit.calledOnce).to.equal(true);
    expect(updateStatus.firstCall.args.slice(0, 3)).to.deep.equal([
      "cloid-1",
      STATUS.PENDING_DEPOSIT_SUBMISSION,
      STATUS.PENDING_DEPOSIT,
    ]);
    // A cleanly promoted order no longer needs receipt reconciliation.
    expect(values.has(recoveryKey)).to.equal(false);
  });

  it("leaves the order and marker for reconciliation when the deposit submission fails", async function () {
    const { internals, account, values } = await makeAdapter();
    stubDirectDepositPreflight(internals);
    const recoveryKey = getPendingBridgeDepositRecoveryKey(internals.REDIS_PREFIX, "cloid-1", account.toNative());
    sinon.stub(internals, "_redisCreateOrder").resolves();
    const updateStatus = sinon.stub(internals, "_redisUpdateOrderStatus").resolves();
    const deleteOrder = sinon.stub(internals, "_redisDeleteOrder").resolves(true);
    sinon.stub(internals, "_depositToBinance").rejects(new Error("submission outcome unknown"));

    await expect(internals.initializeRebalance(ROUTE, toBNWei("6000", 6))).to.be.rejectedWith(
      "submission outcome unknown"
    );

    // The deposit may have broadcast, so the order and its marker must survive for receipt reconciliation.
    expect(updateStatus.called).to.equal(false);
    expect(deleteOrder.called).to.equal(false);
    expect(values.has(recoveryKey)).to.equal(true);
  });

  it("reconciles a recovery-marked submission from its receipt", async function () {
    const { internals, account, values } = await makeAdapter();
    const recoveryKey = getPendingBridgeDepositRecoveryKey(internals.REDIS_PREFIX, "cloid-1", account.toNative());
    const txnKey = getPendingBridgeDepositTxnKey(internals.REDIS_PREFIX, "cloid-1", account.toNative());
    values.set(recoveryKey, "1");
    values.set(txnKey, JSON.stringify({ chainId: CHAIN_IDs.MAINNET, transactionHash: "0xdeposit" }));
    const updateStatus = sinon.stub(internals, "_redisUpdateOrderStatus").resolves();
    const receipt = sinon.stub(internals, "_getDepositTransactionReceipt").resolves({ status: 1 });

    await internals._reconcileDepositRecovery("cloid-1");

    expect(receipt.firstCall.args).to.deep.equal([CHAIN_IDs.MAINNET, "0xdeposit"]);
    expect(updateStatus.firstCall.args.slice(0, 3)).to.deep.equal([
      "cloid-1",
      STATUS.PENDING_DEPOSIT_SUBMISSION,
      STATUS.PENDING_DEPOSIT,
    ]);
    expect(values.has(recoveryKey)).to.equal(false);

    // A reverted deposit definitively moved no funds, so the order and its keys are purged.
    values.set(recoveryKey, "1");
    values.set(txnKey, JSON.stringify({ chainId: CHAIN_IDs.MAINNET, transactionHash: "0xdeposit" }));
    receipt.resolves({ status: 0 });
    const deleteOrder = sinon.stub(internals, "_redisDeleteOrder").resolves(true);

    await internals._reconcileDepositRecovery("cloid-1");

    expect(deleteOrder.firstCall.args.slice(0, 2)).to.deep.equal(["cloid-1", STATUS.PENDING_DEPOSIT_SUBMISSION]);
    expect(values.has(recoveryKey)).to.equal(false);
    expect(values.has(txnKey)).to.equal(false);

    // Without persisted transaction data there is no receipt to check: wait for it or the TTL prune.
    values.set(recoveryKey, "1");
    updateStatus.resetHistory();
    deleteOrder.resetHistory();

    await internals._reconcileDepositRecovery("cloid-1");

    expect(updateStatus.called).to.equal(false);
    expect(deleteOrder.called).to.equal(false);
    expect(values.has(recoveryKey)).to.equal(true);
  });

  it("fails closed on markerless pending submissions", async function () {
    const { internals } = await makeAdapter();
    sinon.stub(internals, "_redisGetPendingDepositSubmissions").resolves(["cloid-1"]);
    sinon.stub(internals, "_redisGetPendingBridgesPreDeposit").resolves([]);
    sinon.stub(internals, "_redisGetPendingDeposits").resolves([]);
    sinon.stub(internals, "_redisGetPendingSwaps").resolves([]);
    sinon.stub(internals, "_redisGetPendingWithdrawals").resolves([]);
    sinon.stub(internals, "_redisGetOrderDetailsRequired").resolves({ ...ROUTE, amountToTransfer: toBNWei("6000", 6) });
    const reconcile = sinon.stub(internals, "_reconcileDepositRecovery").resolves();

    await (internals as unknown as BinanceStablecoinSwapAdapter).updateRebalanceStatuses();

    // No recovery marker means no receipt trail: the order must wait for the TTL prune, not progress.
    expect(reconcile.called).to.equal(false);
  });
});

import { ethers, expect, sinon, toBNWei } from "./utils";
import winston from "winston";
import { BaseChainAdapter } from "../src/adapter";
import { BinanceStablecoinSwapBridge } from "../src/adapter/bridges";
import { BinanceStablecoinSwapAdapter } from "../src/rebalancer/adapters/binance";
import { CctpAdapter } from "../src/rebalancer/adapters/cctpAdapter";
import { OftAdapter } from "../src/rebalancer/adapters/oftAdapter";
import { RebalancerConfig } from "../src/rebalancer/RebalancerConfig";
import { RebalanceRoute } from "../src/rebalancer/utils/interfaces";
import { STATUS, getPendingBridgeStatusSetKey } from "../src/rebalancer/utils/utils";
import { BINANCE_NETWORKS, CHAIN_IDs, EvmAddress, TOKEN_SYMBOLS_MAP, toAddressType } from "../src/utils";

const TEST_LOGGER = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as winston.Logger;

// A faithful in-memory Redis covering every operation the adapter's order lifecycle uses.
function makeInMemoryRedis() {
  const values = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    values,
    sets,
    get: async (key: string) => values.get(key),
    set: async (key: string, value: string) => {
      values.set(key, value);
      return "OK";
    },
    del: async (key: string) => Number(values.delete(key)),
    sMembers: async (key: string) => [...(sets.get(key) ?? [])],
    sAdd: async (key: string, value: string) => {
      const members = sets.get(key) ?? new Set<string>();
      sets.set(key, members);
      const before = members.size;
      members.add(value);
      return Number(members.size > before);
    },
    sRem: async (key: string, value: string) => Number(sets.get(key)?.delete(value) ?? false),
    moveSetMember: async (source: string, destination: string, value: string) => {
      const members = sets.get(destination) ?? new Set<string>();
      sets.set(destination, members);
      members.add(value);
      sets.get(source)?.delete(value);
    },
    setAndAddToSet: async (key: string, value: string, setKey: string, setValue: string, _ttl: number) => {
      values.set(key, value);
      const members = sets.get(setKey) ?? new Set<string>();
      sets.set(setKey, members);
      members.add(setValue);
    },
  };
}

/**
 * End-to-end certification of the AdapterManager -> Binance swap path introduced in this PR. Everything between the
 * chain-adapter entrypoint and the rebalancer's Redis order lifecycle runs for real (route derivation, preflight,
 * fee estimation, deposit-transaction construction, order creation and progression, pending-rebalance accounting);
 * only the external boundaries are faked: the Binance HTTP API and on-chain transaction submission.
 */
describe("BinanceStablecoinSwapBridge end-to-end", function () {
  // getProvider(MAINNET) must resolve so the adapter can build (never send - submission is stubbed) the deposit
  // transaction; point it at the local hardhat node.
  before(function () {
    process.env.RPC_PROVIDERS_1 = "TEST";
    process.env.RPC_PROVIDER_TEST_1 = "http://127.0.0.1:8545";
  });
  after(function () {
    delete process.env.RPC_PROVIDERS_1;
    delete process.env.RPC_PROVIDER_TEST_1;
  });

  const l1Usdt = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET]);
  const l2Usdt = toAddressType(TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.AVALANCHE], CHAIN_IDs.AVALANCHE);
  const amount = toBNWei("5.1", 6);

  afterEach(function () {
    sinon.restore();
  });

  async function makeStack(options: { withdrawEnable?: boolean } = {}) {
    // A Wallet (not a hardhat JsonRpcSigner) so the adapter can connect it to the source-chain provider.
    const signer = ethers.Wallet.createRandom();
    const account = EvmAddress.from(signer.address);
    const redis = makeInMemoryRedis();

    const rebalancerAdapter = new BinanceStablecoinSwapAdapter(
      TEST_LOGGER,
      {
        maxPendingOrders: { binance: 1 },
        maxAmountsToTransfer: { USDT: { [CHAIN_IDs.MAINNET]: toBNWei("5.1", 6) } },
      } as unknown as RebalancerConfig,
      signer,
      {} as CctpAdapter,
      {} as OftAdapter
    );
    const internals = rebalancerAdapter as unknown as {
      initialized: boolean;
      availableRoutes: RebalanceRoute[];
      REDIS_PREFIX: string;
      _getAccountCoins(symbol: string, skipCache?: boolean): Promise<unknown>;
      _submitTransaction(txn: unknown): Promise<string>;
      _getBinanceBalance(token: string): Promise<number>;
      _withdraw(cloid: string, quantity: number, token: string, chainId: number): Promise<boolean>;
    };
    // Mimic initialize(): the real one requires a rebalancer-status Redis connection and Binance credentials.
    internals.initialized = true;
    rebalancerAdapter.baseSignerAddress = account;
    Object.assign(rebalancerAdapter, { _redisCache: redis });

    // External boundary 1: the Binance HTTP API.
    sinon.stub(internals, "_getAccountCoins").resolves({
      symbol: "USDT",
      balance: "0",
      networkList: [CHAIN_IDs.MAINNET, CHAIN_IDs.AVALANCHE].map((chainId) => ({
        name: BINANCE_NETWORKS[chainId],
        coin: "USDT",
        withdrawMin: "1",
        withdrawMax: "1000000",
        withdrawFee: "0.04",
        withdrawEnable: options.withdrawEnable ?? true,
        contractAddress: TOKEN_SYMBOLS_MAP.USDT.addresses[chainId],
      })),
    });
    Object.assign(rebalancerAdapter, {
      _binanceApiClient: { depositAddress: async () => ({ address: signer.address }) },
    });
    const binanceBalance = sinon.stub(internals, "_getBinanceBalance").resolves(0);
    const withdraw = sinon.stub(internals, "_withdraw").resolves(true);

    // External boundary 2: on-chain transaction submission.
    const submitted: { method: string; args: unknown[] }[] = [];
    sinon.stub(internals, "_submitTransaction").callsFake(async (txn) => {
      submitted.push(txn as { method: string; args: unknown[] });
      return "0xdeposit";
    });

    // The real registry wiring: BaseChainAdapter owns the bridge exactly as AdapterManager constructs it for
    // CUSTOM_BRIDGE[AVALANCHE][USDT]: one shared rebalancer adapter carrying every registered route.
    internals.availableRoutes = [
      {
        sourceChain: CHAIN_IDs.MAINNET,
        sourceToken: "USDT",
        destinationChain: CHAIN_IDs.AVALANCHE,
        destinationToken: "USDT",
        adapter: "binance",
      },
    ];
    const bridge = new BinanceStablecoinSwapBridge(
      CHAIN_IDs.AVALANCHE,
      CHAIN_IDs.MAINNET,
      signer,
      signer,
      l1Usdt,
      TEST_LOGGER,
      Promise.resolve(rebalancerAdapter)
    );
    const spokePoolClient = { eventSearchConfig: { from: 0, maxBlockLookBack: 5000 } };
    const chainAdapter = new BaseChainAdapter(
      { [CHAIN_IDs.MAINNET]: spokePoolClient, [CHAIN_IDs.AVALANCHE]: spokePoolClient } as never,
      CHAIN_IDs.AVALANCHE,
      CHAIN_IDs.MAINNET,
      {},
      TEST_LOGGER,
      ["USDT"],
      { [l1Usdt.toNative()]: bridge },
      {},
      1
    );
    return { chainAdapter, rebalancerAdapter, internals, account, redis, submitted, binanceBalance, withdraw };
  }

  it("initiates, tracks, and progresses a USDT Mainnet -> Avalanche rebalance", async function () {
    const { chainAdapter, rebalancerAdapter, internals, account, redis, submitted, binanceBalance, withdraw } =
      await makeStack();

    // 1. Amounts above the rebalancer config's transfer cap (5.1 USDT here, mirroring the dev smoke) reject
    // one-shot: the bridge either sends the requested amount or reverts, never a resized one.
    await expect(
      chainAdapter.sendTokenToTargetChain(account, l1Usdt, l2Usdt, toBNWei("6000", 6), false)
    ).to.be.rejectedWith("exceeds the configured Binance maximum");
    expect(submitted).to.be.empty;

    // 2. InventoryClient's entrypoint: sendTokenToTargetChain delegates to the bridge's sendL1ToL2Transfer.
    const response = await chainAdapter.sendTokenToTargetChain(account, l1Usdt, l2Usdt, amount, false);
    expect(response.hash).to.equal("0xdeposit");

    // The initiation built a real direct ERC20 transfer of the requested amount to the Binance deposit address.
    expect(submitted).to.have.lengthOf(1);
    expect(submitted[0].method).to.equal("transfer");
    expect(submitted[0].args[1]).to.equal(amount);

    // 3. The transfer exists as a PENDING_DEPOSIT Redis order carrying the bridge-derived route.
    const depositSet = getPendingBridgeStatusSetKey(internals.REDIS_PREFIX, STATUS.PENDING_DEPOSIT, account.toNative());
    expect(redis.sets.get(depositSet)?.size).to.equal(1);
    const [cloid] = redis.sets.get(depositSet) ?? [];
    const order = JSON.parse(
      redis.values.get(`${internals.REDIS_PREFIX}pending-order:${cloid}:${account.toNative().toLowerCase()}`) ?? "{}"
    );
    expect(order).to.deep.include({
      sourceChain: CHAIN_IDs.MAINNET,
      sourceToken: "USDT",
      destinationChain: CHAIN_IDs.AVALANCHE,
      destinationToken: "USDT",
      amountToTransfer: amount.toString(),
    });

    // 4. The pending order surfaces as an Avalanche virtual-balance credit, which is what stops InventoryClient
    // from re-initiating the same transfer on the next run.
    const pending = await rebalancerAdapter.getPendingRebalances(account);
    expect(pending[CHAIN_IDs.AVALANCHE]?.USDT).to.equal(amount);

    // 5. The swap rebalancer's normal lifecycle progresses the order: once the deposit is credited on Binance,
    // the withdrawal to Avalanche is initiated and the order moves to PENDING_WITHDRAWAL.
    await rebalancerAdapter.updateRebalanceStatuses();
    expect(withdraw.called).to.equal(false); // Deposit not credited yet: nothing to withdraw.

    binanceBalance.resolves(5.1);
    await rebalancerAdapter.updateRebalanceStatuses();
    expect(withdraw.calledOnce).to.equal(true);
    expect(withdraw.firstCall.args.slice(1)).to.deep.equal([5.1, "USDT", CHAIN_IDs.AVALANCHE]);
    const withdrawalSet = getPendingBridgeStatusSetKey(
      internals.REDIS_PREFIX,
      STATUS.PENDING_WITHDRAWAL,
      account.toNative()
    );
    expect(redis.sets.get(depositSet)?.size).to.equal(0);
    expect(redis.sets.get(withdrawalSet)?.size).to.equal(1);
  });

  it("declines routes that would need an intermediate bridge into Binance", async function () {
    const { chainAdapter, internals, account, redis, submitted } = await makeStack();
    // Binance drops the source-chain network entry, so the entrypoint falls back to an intermediate bridge leg.
    (internals._getAccountCoins as sinon.SinonStub).resolves({
      symbol: "USDT",
      balance: "0",
      networkList: [
        {
          name: BINANCE_NETWORKS[CHAIN_IDs.AVALANCHE],
          coin: "USDT",
          withdrawMin: "1",
          withdrawMax: "1000000",
          withdrawFee: "0.04",
          withdrawEnable: true,
          contractAddress: TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.AVALANCHE],
        },
      ],
    });

    await expect(chainAdapter.sendTokenToTargetChain(account, l1Usdt, l2Usdt, amount, false)).to.be.rejected;
    expect(submitted).to.be.empty;
    expect(redis.sets.size).to.equal(0);
  });

  it("declines when Binance has suspended withdrawals on the destination network", async function () {
    const { chainAdapter, account, redis, submitted } = await makeStack({ withdrawEnable: false });

    // The preflight gate rejects before any funds move, and the decline is typed so InventoryClient rolls back.
    await expect(chainAdapter.sendTokenToTargetChain(account, l1Usdt, l2Usdt, amount, false)).to.be.rejected;
    expect(submitted).to.be.empty;
    expect(redis.sets.size).to.equal(0);
  });
});

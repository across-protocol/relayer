import sinon from "sinon";
import { expect } from "chai";
import { getCurrentTime, getDepositKey, Signer, toBN, TransactionReceipt, winston } from "../src/utils";
import { DepositAddressMessage, DepositAddressMessageV3 } from "../src/interfaces/DepositAddress";
import { DepositAddressExecuteResponse } from "../src/clients";
import { DepositAddressHandler } from "../src/deposit-address/DepositAddressHandler";
import { DepositAddressHandlerConfig } from "../src/deposit-address/DepositAddressHandlerConfig";

const BOT_IDENTIFIER = "test-deposit-address-handler";
const RUN_IDENTIFIER = "instance-a";
const OTHER_INSTANCE = "instance-b";
const DEPOSIT_ADDRESS = "0x000000000000000000000000000000000000C0DE";
const REFUND_ADDRESS = "0x0000000000000000000000000000000000002222";
const TOKEN = "0x000000000000000000000000000000000000DEAD";
const OUTPUT_TOKEN = "0x0000000000000000000000000000000000005678";
const RECIPIENT = "0x0000000000000000000000000000000000001111";
const EXECUTE_TARGET = "0x0000000000000000000000000000000000005900";
const V3_CHAIN = 42161;
const V1_CHAIN = 1;

/**
 * Minimal in-memory stand-in for the Redis ops the handler uses: plain keys (get/set/del),
 * native sets (sAdd/sRem/sMembers/sIsMember) and the token-guarded lock trio.
 */
class FakeRedis {
  store = new Map<string, string>();
  sets = new Map<string, Set<string>>();

  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) ?? null) as T | null;
  }

  async set<T>(key: string, val: T): Promise<string> {
    this.store.set(key, String(val));
    return "OK";
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async acquireLock(key: string, token: string): Promise<boolean> {
    if (this.store.has(key)) {
      return false;
    }
    this.store.set(key, token);
    return true;
  }

  async renewLock(key: string, token: string): Promise<boolean> {
    return this.store.get(key) === token;
  }

  async releaseLock(key: string, token: string): Promise<boolean> {
    if (this.store.get(key) === token) {
      this.store.delete(key);
      return true;
    }
    return false;
  }

  async sAdd(key: string, value: string): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    const added = set.has(value) ? 0 : 1;
    set.add(value);
    this.sets.set(key, set);
    return added;
  }

  async sRem(key: string, value: string): Promise<number> {
    return this.sets.get(key)?.delete(value) ? 1 : 0;
  }

  async sMembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async sIsMember(key: string, value: string): Promise<boolean> {
    return this.sets.get(key)?.has(value) ?? false;
  }

  async expire(): Promise<boolean> {
    return true;
  }
}

function pendingKey(message: DepositAddressMessage | DepositAddressMessageV3): string {
  return `deposit-address:pending-execution:${BOT_IDENTIFIER}:${getDepositKey(message)}`;
}

const EXECUTED_KEY = `deposit-address:executed:${BOT_IDENTIFIER}:v2`;
const LEGACY_EXECUTED_KEY = `deposit-address:executed:${BOT_IDENTIFIER}`;

function fakeReceipt(): TransactionReceipt {
  return { transactionHash: "0x" + "9".repeat(64), blockNumber: 1_234_567, logs: [] } as unknown as TransactionReceipt;
}

function depositMessageV3(): DepositAddressMessageV3 {
  return {
    depositAddress: DEPOSIT_ADDRESS,
    version: 3,
    salt: "0x" + "0".repeat(64),
    initialRoot: "0x" + "2".repeat(64),
    counterfactualBeaconContractAddress: "0x000000000000000000000000000000000000B1B1",
    counterfactualFactoryContractAddress: "0x000000000000000000000000000000000000B2B2",
    adminWithdrawManagerContractAddress: "0x000000000000000000000000000000000000B3B3",
    shouldSponsorAccountCreation: false,
    counterfactualMaterials: [],
    routeParams: {
      outputToken: OUTPUT_TOKEN,
      destinationChainId: "1337",
      recipient: { namespace: "evm", address: RECIPIENT },
    },
    refundAddress: { namespace: "evm", address: REFUND_ADDRESS },
    depositAddressNamespace: "evm",
    integrator: { name: "test-integrator", integratorId: "0xdead" },
    erc20Transfer: {
      chainId: String(V3_CHAIN),
      blockNumber: 1_000_000,
      logIndex: 4,
      from: REFUND_ADDRESS,
      to: DEPOSIT_ADDRESS,
      amount: "5000",
      contractAddress: TOKEN,
      transactionHash: "0x" + "3".repeat(64),
      transferClassification: "correct_transfer",
    },
  };
}

function withdrawMessageV1(): DepositAddressMessage {
  return {
    depositAddress: DEPOSIT_ADDRESS,
    paramsHash: "0x" + "0".repeat(64),
    salt: "0x" + "0".repeat(64),
    counterfactualDepositContractAddress: "0x000000000000000000000000000000000000A1A1",
    counterfactualFactoryContractAddress: "0x000000000000000000000000000000000000A2A2",
    adminWithdrawManagerContractAddress: "0x000000000000000000000000000000000000A3A3",
    shouldSponsorAccountCreation: false,
    counterfactualMaterials: undefined,
    routeParams: {
      inputToken: TOKEN,
      outputToken: OUTPUT_TOKEN,
      originChainId: String(V1_CHAIN),
      destinationChainId: "10",
      recipient: RECIPIENT,
      refundAddress: REFUND_ADDRESS,
    },
    erc20Transfer: {
      chainId: String(V1_CHAIN),
      blockNumber: 1_000_000,
      logIndex: 4,
      from: REFUND_ADDRESS,
      to: DEPOSIT_ADDRESS,
      amount: "5000",
      contractAddress: TOKEN,
      transactionHash: "0x" + "1".repeat(64),
      transferClassification: "mis_route",
    },
  };
}

function executeResponse(): DepositAddressExecuteResponse {
  return {
    depositAddress: DEPOSIT_ADDRESS,
    isPlaceholder: false,
    signatureDeadline: getCurrentTime() + 300,
    executeTx: { to: EXECUTE_TARGET, data: "0x", value: "0", chainId: V3_CHAIN },
  } as unknown as DepositAddressExecuteResponse;
}

type HandlerInternals = {
  redisCache: FakeRedis;
  abortController: AbortController;
  initiateDepositV3: (m: DepositAddressMessageV3) => Promise<void>;
  initiateWithdraw: (m: DepositAddressMessage) => Promise<void>;
  evaluateDepositAddresses: () => Promise<void>;
  trackTick: (tick: Promise<unknown>) => Promise<unknown>;
  drainInFlightWork: (timeoutSeconds: number) => Promise<void>;
  waitForDisconnect: () => Promise<void>;
  observedExecutedDeposits: { [chainId: number]: Set<string> };
  executedDepositTxHashes: Set<string>;
  _loadPersistedSet: (redisKey: string, legacyRedisKey: string) => Promise<Set<string>>;
};

function buildHandler(): {
  handler: DepositAddressHandler;
  internals: HandlerInternals;
  redis: FakeRedis;
  sendStub: sinon.SinonStub;
  executeTxStub: sinon.SinonStub;
} {
  const config = {
    botIdentifier: BOT_IDENTIFIER,
    runIdentifier: RUN_IDENTIFIER,
    relayerOriginChains: [V1_CHAIN, V3_CHAIN],
    withdrawEnabled: true,
    enableV3Withdrawals: true,
  } as unknown as DepositAddressHandlerConfig;
  const logger = { debug: sinon.stub(), warn: sinon.stub(), error: sinon.stub() } as unknown as winston.Logger;
  // A non-empty signer list selects the dispatcher path, keeping getExecuteContract from
  // dereferencing real providers; the broadcast itself is stubbed via sendAndConfirm.
  const handler = new DepositAddressHandler(logger, config, {} as unknown as Signer, [{} as unknown as Signer]);

  const redis = new FakeRedis();
  const sendStub = sinon.stub().resolves(fakeReceipt());
  const executeTxStub = sinon.stub().resolves(executeResponse());
  const balanceStub = sinon.stub().resolves(toBN("5000"));
  Object.assign(handler, {
    redisCache: redis,
    observedExecutedDeposits: { [V1_CHAIN]: new Set(), [V3_CHAIN]: new Set() },
    observedExecutedWithdraws: { [V1_CHAIN]: new Set(), [V3_CHAIN]: new Set() },
    sendAndConfirm: sendStub,
    _getExecuteTx: executeTxStub,
    getDepositAddressBalance: balanceStub,
  });
  return { handler, internals: handler as unknown as HandlerInternals, redis, sendStub, executeTxStub };
}

describe("DepositAddressHandler pending-execution locks", function () {
  afterEach(() => sinon.restore());

  it("holds the lock during the broadcast, then commits the member and releases", async function () {
    const { internals, redis, sendStub } = buildHandler();
    const message = depositMessageV3();

    sendStub.callsFake(async () => {
      // At broadcast time the pending-execution lock must be held under this instance's token.
      expect(redis.store.get(pendingKey(message))).to.equal(RUN_IDENTIFIER);
      return fakeReceipt();
    });

    await internals.initiateDepositV3(message);

    expect(sendStub.calledOnce).to.equal(true);
    expect(redis.store.has(pendingKey(message))).to.equal(false);
    expect(redis.sets.get(EXECUTED_KEY)?.has(message.erc20Transfer.transactionHash)).to.equal(true);
  });

  it("defers execution while another instance holds the lock", async function () {
    const { internals, redis, sendStub, executeTxStub } = buildHandler();
    const message = depositMessageV3();
    redis.store.set(pendingKey(message), OTHER_INSTANCE);

    await internals.initiateDepositV3(message);

    expect(executeTxStub.notCalled).to.equal(true);
    expect(sendStub.notCalled).to.equal(true);
    // The foreign lock is untouched: the deferral holds until the owner releases it or TTL expires.
    expect(redis.store.get(pendingKey(message))).to.equal(OTHER_INSTANCE);
  });

  it("does not defer on its own lock (normal retry path renews it)", async function () {
    const { internals, redis, sendStub } = buildHandler();
    const message = depositMessageV3();
    redis.store.set(pendingKey(message), RUN_IDENTIFIER);

    await internals.initiateDepositV3(message);

    expect(sendStub.calledOnce).to.equal(true);
  });

  it("keeps the lock on a failed submit and still allows this instance to retry", async function () {
    const { internals, redis, sendStub } = buildHandler();
    const message = depositMessageV3();
    sendStub.resolves(undefined);

    await internals.initiateDepositV3(message);

    // A failed sendAndConfirm may still have broadcast; the lock must outlive it (TTL cleanup).
    expect(redis.store.get(pendingKey(message))).to.equal(RUN_IDENTIFIER);
    expect(redis.sets.has(EXECUTED_KEY)).to.equal(false);
    // The in-flight lock was released, and the own pending lock renews rather than blocks.
    await internals.initiateDepositV3(message);
    expect(sendStub.calledTwice).to.equal(true);
  });

  it("does not broadcast when another instance acquires the lock after the early foreign check", async function () {
    // The early hasForeignPendingExecution read is advisory; a concurrent instance can take the
    // lock between it and the checkpoint. The atomic acquire must lose and skip the broadcast.
    const { internals, redis, sendStub, executeTxStub } = buildHandler();
    const message = depositMessageV3();
    executeTxStub.callsFake(async () => {
      // Runs after the early check, before the checkpoint — the other instance wins the lock here.
      redis.store.set(pendingKey(message), OTHER_INSTANCE);
      return executeResponse();
    });

    await internals.initiateDepositV3(message);

    expect(sendStub.notCalled).to.equal(true);
    expect(redis.store.get(pendingKey(message))).to.equal(OTHER_INSTANCE);
  });

  it("does not release a lock another instance acquired after this instance's expired mid-flight", async function () {
    // If the broadcast outlives the lock TTL and another instance re-acquires it, the token-guarded
    // release after commit must leave the other instance's lock in place.
    const { internals, redis, sendStub } = buildHandler();
    const message = depositMessageV3();
    sendStub.callsFake(async () => {
      // Simulate TTL expiry + re-acquisition by the other instance while the tx confirms.
      redis.store.set(pendingKey(message), OTHER_INSTANCE);
      return fakeReceipt();
    });

    await internals.initiateDepositV3(message);

    // The execution still commits (it is on-chain), but the foreign lock survives the release.
    expect(redis.sets.get(EXECUTED_KEY)?.has(message.erc20Transfer.transactionHash)).to.equal(true);
    expect(redis.store.get(pendingKey(message))).to.equal(OTHER_INSTANCE);
  });

  it("skips the broadcast when the transfer was committed by another instance under no lock", async function () {
    // Simulates the race the committed-set re-check closes: the other instance committed and
    // released its lock after this tick's refresh, so memory is stale and no lock is visible.
    const { internals, redis, sendStub } = buildHandler();
    const message = depositMessageV3();
    redis.sets.set(EXECUTED_KEY, new Set([message.erc20Transfer.transactionHash]));

    await internals.initiateDepositV3(message);

    expect(sendStub.notCalled).to.equal(true);
    // The checkpoint's probe lock was released again — nothing is left deferring the transfer.
    expect(redis.store.has(pendingKey(message))).to.equal(false);
  });

  it("skips the broadcast without taking the lock when a handover was observed mid-message", async function () {
    const { internals, redis, sendStub } = buildHandler();
    const message = depositMessageV3();
    internals.abortController.abort();

    await internals.initiateDepositV3(message);

    expect(sendStub.notCalled).to.equal(true);
    expect(redis.store.has(pendingKey(message))).to.equal(false);
    expect(internals.observedExecutedDeposits[V3_CHAIN].size).to.equal(0);
  });

  it("defers the v1 refund-withdraw path on a foreign lock before any chain reads", async function () {
    const { handler, internals, redis, sendStub } = buildHandler();
    const message = withdrawMessageV1();
    redis.store.set(pendingKey(message), OTHER_INSTANCE);
    const balanceStub = (handler as unknown as { getDepositAddressBalance: sinon.SinonStub }).getDepositAddressBalance;

    await internals.initiateWithdraw(message);

    expect(balanceStub.notCalled).to.equal(true);
    expect(sendStub.notCalled).to.equal(true);
  });
});

describe("DepositAddressHandler committed-set refresh, prune and migration", function () {
  afterEach(() => sinon.restore());

  it("picks up commits from a concurrently-running instance within one tick", async function () {
    const { handler, internals, redis, sendStub } = buildHandler();
    const message = depositMessageV3();
    // Committed by the other instance after this instance booted: present in Redis, not in memory.
    redis.sets.set(EXECUTED_KEY, new Set([message.erc20Transfer.transactionHash]));
    Object.assign(handler, { _queryIndexerApi: sinon.stub().resolves([message]) });

    await internals.evaluateDepositAddresses();

    expect(internals.executedDepositTxHashes.has(message.erc20Transfer.transactionHash)).to.equal(true);
    expect(sendStub.notCalled).to.equal(true);
  });

  it("prunes members the indexer no longer returns from memory and Redis", async function () {
    const { handler, internals, redis } = buildHandler();
    const stale = "0x" + "7".repeat(64);
    internals.executedDepositTxHashes.add(stale);
    redis.sets.set(EXECUTED_KEY, new Set([stale]));
    Object.assign(handler, { _queryIndexerApi: sinon.stub().resolves([]) });

    await internals.evaluateDepositAddresses();

    expect(internals.executedDepositTxHashes.has(stale)).to.equal(false);
    expect(redis.sets.get(EXECUTED_KEY)?.has(stale)).to.equal(false);
  });

  it("migrates the legacy JSON blob into the native set on first load", async function () {
    const { internals, redis } = buildHandler();
    redis.store.set(LEGACY_EXECUTED_KEY, JSON.stringify(["0xaaa", "0xbbb"]));

    const loaded = await internals._loadPersistedSet(EXECUTED_KEY, LEGACY_EXECUTED_KEY);

    expect([...loaded].sort()).to.deep.equal(["0xaaa", "0xbbb"]);
    expect([...(redis.sets.get(EXECUTED_KEY) ?? [])].sort()).to.deep.equal(["0xaaa", "0xbbb"]);
    // The legacy key is left in place for rollback.
    expect(redis.store.has(LEGACY_EXECUTED_KEY)).to.equal(true);
  });

  it("prefers the native set over the legacy blob once it is populated", async function () {
    const { internals, redis } = buildHandler();
    redis.sets.set(EXECUTED_KEY, new Set(["0xccc"]));
    redis.store.set(LEGACY_EXECUTED_KEY, JSON.stringify(["0xaaa"]));

    const loaded = await internals._loadPersistedSet(EXECUTED_KEY, LEGACY_EXECUTED_KEY);

    expect([...loaded]).to.deep.equal(["0xccc"]);
  });
});

describe("DepositAddressHandler handover draining", function () {
  afterEach(() => sinon.restore());

  it("stops initiating executions once aborted", async function () {
    const { handler, internals } = buildHandler();
    const processStub = sinon.stub().resolves();
    Object.assign(handler, {
      _queryIndexerApi: sinon.stub().resolves([depositMessageV3()]),
      processExecution: processStub,
    });
    internals.abortController.abort();

    await internals.evaluateDepositAddresses();

    expect(processStub.notCalled).to.equal(true);
  });

  it("drainInFlightWork waits for in-flight ticks to settle", async function () {
    const { internals } = buildHandler();
    let resolveTick: (() => void) | undefined;
    void internals.trackTick(new Promise<void>((resolve) => (resolveTick = resolve)));

    let drained = false;
    const drain = internals.drainInFlightWork(5).then(() => (drained = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drained).to.equal(false);

    resolveTick?.();
    await drain;
    expect(drained).to.equal(true);
  });

  it("drainInFlightWork gives up after the timeout when a tick never settles", async function () {
    const { internals } = buildHandler();
    void internals.trackTick(new Promise(() => undefined));
    await internals.drainInFlightWork(0);
  });

  it("waitForDisconnect aborts, then drains in-flight work before resolving", async function () {
    const { handler, internals } = buildHandler();
    const coordinator = { subscribe: sinon.stub().resolves(OTHER_INSTANCE) };
    Object.assign(handler, { _instanceCoordinator: coordinator });

    let tickSettled = false;
    void internals.trackTick(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          tickSettled = true;
          resolve();
        }, 20)
      )
    );

    await internals.waitForDisconnect();

    expect(internals.abortController.signal.aborted).to.equal(true);
    expect(tickSettled).to.equal(true);
  });
});

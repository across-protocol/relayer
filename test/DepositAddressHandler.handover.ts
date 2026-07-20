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

/** Minimal in-memory stand-in for the Redis ops the handler uses (get/set/locks). */
class FakeRedis {
  store = new Map<string, string>();

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

  /** SET NX semantics; TTLs are not modelled. */
  async acquireLock(key: string, token: string, _ttlMs: number): Promise<boolean> {
    if (this.store.has(key)) {
      return false;
    }
    this.store.set(key, token);
    return true;
  }

  async renewLock(key: string, token: string, _ttlMs: number): Promise<boolean> {
    return this.store.get(key) === token;
  }

  async releaseLock(key: string, token: string): Promise<boolean> {
    if (this.store.get(key) !== token) {
      return false;
    }
    return this.store.delete(key);
  }
}

function pendingKey(message: DepositAddressMessage | DepositAddressMessageV3): string {
  return `deposit-address:pending-execution:${BOT_IDENTIFIER}:${getDepositKey(message)}`;
}

function executedKey(): string {
  return `deposit-address:executed:${BOT_IDENTIFIER}`;
}

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

describe("DepositAddressHandler pending-execution markers", function () {
  afterEach(() => sinon.restore());

  it("writes the marker before broadcasting and clears it after persisting the executed marker", async function () {
    const { internals, redis, sendStub } = buildHandler();
    const message = depositMessageV3();

    sendStub.callsFake(async () => {
      // At broadcast time the pending marker must already be persisted under this instance.
      expect(redis.store.get(pendingKey(message))).to.equal(RUN_IDENTIFIER);
      return fakeReceipt();
    });

    await internals.initiateDepositV3(message);

    expect(sendStub.calledOnce).to.equal(true);
    expect(redis.store.has(pendingKey(message))).to.equal(false);
    expect(redis.store.get(executedKey())).to.contain(message.erc20Transfer.transactionHash);
  });

  it("defers execution while another instance holds the pending marker", async function () {
    const { internals, redis, sendStub, executeTxStub } = buildHandler();
    const message = depositMessageV3();
    redis.store.set(pendingKey(message), OTHER_INSTANCE);

    await internals.initiateDepositV3(message);

    expect(executeTxStub.notCalled).to.equal(true);
    expect(sendStub.notCalled).to.equal(true);
    // The marker was not consumed: the deferral holds until the owner clears it or the TTL expires.
    expect(redis.store.get(pendingKey(message))).to.equal(OTHER_INSTANCE);
  });

  it("does not defer on its own marker (normal retry path)", async function () {
    const { internals, redis, sendStub } = buildHandler();
    const message = depositMessageV3();
    redis.store.set(pendingKey(message), RUN_IDENTIFIER);

    await internals.initiateDepositV3(message);

    expect(sendStub.calledOnce).to.equal(true);
  });

  it("keeps the marker on a failed submit and still allows this instance to retry", async function () {
    const { internals, redis, sendStub } = buildHandler();
    const message = depositMessageV3();
    sendStub.resolves(undefined);

    await internals.initiateDepositV3(message);

    // A failed sendAndConfirm may still have broadcast; the marker must outlive it (TTL cleanup).
    expect(redis.store.get(pendingKey(message))).to.equal(RUN_IDENTIFIER);
    expect(redis.store.has(executedKey())).to.equal(false);
    // The in-flight lock was released, and the own marker does not block the retry.
    await internals.initiateDepositV3(message);
    expect(sendStub.calledTwice).to.equal(true);
  });

  it("skips the broadcast without writing a marker when a handover was observed mid-message", async function () {
    const { internals, redis, sendStub } = buildHandler();
    const message = depositMessageV3();
    internals.abortController.abort();

    await internals.initiateDepositV3(message);

    expect(sendStub.notCalled).to.equal(true);
    expect(redis.store.has(pendingKey(message))).to.equal(false);
    expect(internals.observedExecutedDeposits[V3_CHAIN].size).to.equal(0);
  });

  it("does not broadcast when another instance acquires the marker after the early foreign check", async function () {
    const { internals, redis, sendStub, executeTxStub } = buildHandler();
    const message = depositMessageV3();
    // The early hasForeignPendingExecution read passes (no marker yet); the other instance's
    // marker lands while this instance is fetching calldata, i.e. before the pre-broadcast
    // checkpoint. The atomic acquisition must lose and skip the broadcast.
    executeTxStub.callsFake(async () => {
      redis.store.set(pendingKey(message), OTHER_INSTANCE);
      return executeResponse();
    });

    await internals.initiateDepositV3(message);

    expect(sendStub.notCalled).to.equal(true);
    expect(redis.store.get(pendingKey(message))).to.equal(OTHER_INSTANCE);
    // The in-flight lock was released so the transfer is re-evaluated on later polls.
    expect(internals.observedExecutedDeposits[V3_CHAIN].size).to.equal(0);
  });

  it("does not clear a marker another instance acquired after this instance's expired mid-flight", async function () {
    const { internals, redis, sendStub } = buildHandler();
    const message = depositMessageV3();

    sendStub.callsFake(async () => {
      // Simulate the marker TTL expiring during a slow confirmation, with another instance then
      // acquiring the key. The ownership-checked release must leave that marker intact.
      redis.store.set(pendingKey(message), OTHER_INSTANCE);
      return fakeReceipt();
    });

    await internals.initiateDepositV3(message);

    expect(redis.store.get(executedKey())).to.contain(message.erc20Transfer.transactionHash);
    expect(redis.store.get(pendingKey(message))).to.equal(OTHER_INSTANCE);
  });

  it("defers the v1 refund-withdraw path on a foreign marker before any chain reads", async function () {
    const { handler, internals, redis, sendStub } = buildHandler();
    const message = withdrawMessageV1();
    redis.store.set(pendingKey(message), OTHER_INSTANCE);
    const balanceStub = (handler as unknown as { getDepositAddressBalance: sinon.SinonStub }).getDepositAddressBalance;

    await internals.initiateWithdraw(message);

    expect(balanceStub.notCalled).to.equal(true);
    expect(sendStub.notCalled).to.equal(true);
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

  it("waitForDisconnect aborts, drains in-flight work, then signals drained", async function () {
    const { handler, internals } = buildHandler();
    const events: string[] = [];
    const coordinator = {
      subscribe: sinon.stub().resolves(OTHER_INSTANCE),
      signalDrained: sinon.stub().callsFake(async () => void events.push("drained")),
    };
    Object.assign(handler, { _instanceCoordinator: coordinator });

    void internals.trackTick(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          events.push("tickSettled");
          resolve();
        }, 20)
      )
    );

    await internals.waitForDisconnect();

    expect(internals.abortController.signal.aborted).to.equal(true);
    expect(events).to.deep.equal(["tickSettled", "drained"]);
  });
});

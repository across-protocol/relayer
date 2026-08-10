import { expect } from "./utils";
import { TransactionReceipt } from "../src/utils";
import {
  TerminalState,
  TransferStore,
  TransferStoreRedis,
  classifyReceipt,
  isTerminal,
} from "../src/deposit-address-service/transferState";

const TRANSFER = "42161:0xa3f1c7d40e9b6852f1ad0c3b7e94f628a1d5c09e:7";
const LOCK_KEY = `deposit-address:lock:${TRANSFER}`;
const STATE_KEY = `deposit-address:state:${TRANSFER}`;

const PENDING = { operation: "deposit", txHash: "0xh1", chainId: 42161, submittedAtMs: 1_700_000_000_000 } as const;
const EXECUTED: TerminalState = {
  status: "deposit_executed",
  txHash: "0xh1",
  chainId: 42161,
  blockNumber: 312884201,
  completedAtMs: 1_700_000_005_000,
};

/** Only the commands the store issues. `satisfies` keeps it honest without a cast. */
function fakeRedis(seed: Array<[string, string]> = [], opts: { setFails?: boolean; rejects?: boolean } = {}) {
  const store = new Map<string, string>(seed);
  const ttls = new Map<string, number>();
  const redis = {
    async acquireLock(key: string, token: string, ttlMs: number) {
      if (store.has(key)) {
        return false;
      }
      store.set(key, token);
      ttls.set(key, ttlMs);
      return true;
    },
    async releaseLock(key: string, token: string) {
      if (store.get(key) !== token) {
        return false;
      }
      store.delete(key);
      return true;
    },
    async get<T>(key?: string) {
      if (opts.rejects) {
        throw new Error("READONLY You can't write against a read only replica");
      }
      return (store.get(key ?? "") ?? null) as T | null;
    },
    async set<T>(key: string, val: T, expirySeconds?: number) {
      if (opts.setFails) {
        return undefined;
      }
      store.set(key, String(val));
      ttls.set(key, expirySeconds ?? -1);
      return "OK";
    },
    async del(key: string) {
      return store.delete(key) ? 1 : 0;
    },
  } satisfies TransferStoreRedis;
  return { redis, store, ttls };
}

function receipt(over: Partial<TransactionReceipt> = {}): TransactionReceipt {
  return { blockNumber: 312884201, status: 1, ...over } as TransactionReceipt;
}

describe("classifyReceipt", function () {
  it("reports a mined transaction as confirmed", function () {
    expect(classifyReceipt(receipt())).to.equal("confirmed");
  });

  it("reports only an explicit status of 0 as reverted", function () {
    expect(classifyReceipt(receipt({ status: 0 }))).to.equal("reverted");
  });

  it("reads a receipt with no status as confirmed rather than re-broadcasting", function () {
    // ethers leaves status undefined on some chains. Guessing confirmed can strand a deposit for manual
    // recovery; guessing reverted would re-broadcast one that already landed. Only the first is reversible.
    expect(classifyReceipt(receipt({ status: undefined }))).to.equal("confirmed");
  });

  it("is unresolved without a receipt, so a transaction that may still land is never retried", function () {
    expect(classifyReceipt(undefined)).to.equal("unresolved");
    expect(classifyReceipt(null)).to.equal("unresolved");
    expect(classifyReceipt(receipt({ blockNumber: undefined }))).to.equal("unresolved");
  });
});

describe("TransferStore lock", function () {
  it("admits one holder and refuses the second", async function () {
    // The only thing stopping two live consumers both passing the pre-broadcast checks.
    const store = new TransferStore(fakeRedis().redis);
    expect(await store.acquireLock(TRANSFER)).to.not.equal(undefined);
    expect(await store.acquireLock(TRANSFER)).to.equal(undefined);
  });

  it("generates its own token, so no caller can supply or reuse one", async function () {
    const { redis, store: backing } = fakeRedis();
    const store = new TransferStore(redis);

    const first = await store.acquireLock(TRANSFER);
    const firstToken = backing.get(LOCK_KEY);
    await first?.release();
    await store.acquireLock(TRANSFER);

    expect(firstToken).to.be.a("string");
    expect(backing.get(LOCK_KEY)).to.not.equal(firstToken);
  });

  it("releases only for the holder, so a stale attempt cannot free a live lock", async function () {
    const { redis, store: backing } = fakeRedis();
    const store = new TransferStore(redis);

    const stale = await store.acquireLock(TRANSFER);
    await stale?.release();
    const live = await store.acquireLock(TRANSFER);

    // The stale handle's token is no longer in Redis, so releasing it again cannot touch the live lock.
    expect(await stale?.release()).to.equal(false);
    expect(backing.has(LOCK_KEY)).to.equal(true);
    expect(await live?.release()).to.equal(true);
  });

  it("uses a TTL, so a dead consumer does not block the transfer forever", async function () {
    const { redis, ttls } = fakeRedis();
    await new TransferStore(redis).acquireLock(TRANSFER);
    expect(ttls.get(LOCK_KEY)).to.equal(600_000);
  });
});

describe("TransferStore state", function () {
  it("reads back nothing for a transfer never seen", async function () {
    expect(await new TransferStore(fakeRedis().redis).read(TRANSFER)).to.equal(undefined);
  });

  it("round-trips a broadcast record and never expires it", async function () {
    // A pending record must outlive anything that could still land on-chain.
    const { redis, ttls } = fakeRedis();
    const store = new TransferStore(redis);
    await store.recordBroadcast(TRANSFER, PENDING);

    expect(ttls.get(STATE_KEY)).to.equal(Number.POSITIVE_INFINITY);
    const state = await store.read(TRANSFER);
    expect(state?.status).to.equal("broadcast_pending");
    expect(state && isTerminal(state)).to.equal(false);
  });

  it("round-trips each terminal status with a 90-day TTL", async function () {
    for (const terminal of [
      EXECUTED,
      { ...EXECUTED, status: "withdraw_executed" },
      { status: "withdraw_failed", code: "GAS_EXCEEDS_REFUND", reason: "dust", recordedAtMs: 5 },
    ] as TerminalState[]) {
      const { redis, ttls } = fakeRedis();
      const store = new TransferStore(redis);
      await store.recordTerminal(TRANSFER, terminal);

      expect(ttls.get(STATE_KEY)).to.equal(90 * 24 * 60 * 60);
      const read = await store.read(TRANSFER);
      expect(read?.status).to.equal(terminal.status);
      expect(read && isTerminal(read)).to.equal(true);
    }
  });

  it("rewrites an identical terminal state without complaint", async function () {
    const store = new TransferStore(fakeRedis().redis);
    await store.recordTerminal(TRANSFER, EXECUTED);
    await store.recordTerminal(TRANSFER, EXECUTED);
    expect((await store.read(TRANSFER))?.status).to.equal("deposit_executed");
  });

  it("refuses to write broadcast_pending over a terminal outcome", async function () {
    // The one transition that loses funds-safety information. Reaching it means a caller skipped the
    // state read every path begins with.
    const store = new TransferStore(fakeRedis().redis);
    await store.recordTerminal(TRANSFER, EXECUTED);

    await store.recordBroadcast(TRANSFER, PENDING).then(
      () => expect.fail("expected a refusal"),
      (err: Error) => expect(err.message).to.contain("refusing to write broadcast_pending over deposit_executed")
    );
    expect((await store.read(TRANSFER))?.status).to.equal("deposit_executed");
  });

  it("throws when redis does not acknowledge a write", async function () {
    // Awaiting confirmation while believing the hash is durable is the unrecoverable direction.
    const store = new TransferStore(fakeRedis([], { setFails: true }).redis);
    await store.recordBroadcast(TRANSFER, PENDING).then(
      () => expect.fail("expected a persistence failure"),
      (err: Error) => expect(err.message).to.contain("did not acknowledge")
    );
  });

  it("throws on a present-but-unreadable record instead of reading it as absent", async function () {
    // A record we cannot decode may describe a transfer already swept, so it must keep blocking.
    for (const corrupt of [
      "not json",
      '{"status":"nonsense"}',
      '{"status":"broadcast_pending"}',
      // Negative and non-integer timestamps must not deserialize.
      '{"status":"broadcast_pending","operation":"deposit","txHash":"0x1","chainId":1,"submittedAtMs":-1}',
      '{"status":"broadcast_pending","operation":"deposit","txHash":"0x1","chainId":1,"submittedAtMs":1.5}',
    ]) {
      const store = new TransferStore(fakeRedis([[STATE_KEY, corrupt]]).redis);
      await store.read(TRANSFER).then(
        () => expect.fail(`expected a throw for ${corrupt}`),
        (err: Error) => expect(err.message).to.contain("unreadable")
      );
    }
  });

  it("keeps the lock and the state in separate keys", async function () {
    // Their lifetimes are opposites: the lock must expire, the pending record must not.
    const { redis, store: backing } = fakeRedis();
    const store = new TransferStore(redis);
    await store.acquireLock(TRANSFER);
    await store.recordBroadcast(TRANSFER, PENDING);

    expect([...backing.keys()].sort()).to.deep.equal([LOCK_KEY, STATE_KEY].sort());
  });
});

describe("TransferStore terminal guards", function () {
  it("records a terminal outcome over the pending record it belongs to", async function () {
    const store = new TransferStore(fakeRedis().redis);
    await store.recordBroadcast(TRANSFER, PENDING);

    await store.recordTerminal(TRANSFER, EXECUTED);
    expect((await store.read(TRANSFER))?.status).to.equal("deposit_executed");
  });

  it("refuses a terminal outcome for a different transaction than the pending one", async function () {
    // A worker whose lock lapsed must not write h1's outcome over a newer pending h2.
    const store = new TransferStore(fakeRedis().redis);
    await store.recordBroadcast(TRANSFER, { ...PENDING, txHash: "0xh2" });

    await store.recordTerminal(TRANSFER, EXECUTED).then(
      () => expect.fail("expected a refusal"),
      (err: Error) => expect(err.message).to.contain("refusing to write deposit_executed over broadcast_pending")
    );
    const state = await store.read(TRANSFER);
    expect(state?.status).to.equal("broadcast_pending");
    expect(state && "txHash" in state && state.txHash).to.equal("0xh2");
  });

  it("refuses withdraw_failed over a pending broadcast that may still land", async function () {
    // It carries no hash, so it can never be the outcome of the transaction on the wire.
    const store = new TransferStore(fakeRedis().redis);
    await store.recordBroadcast(TRANSFER, { ...PENDING, operation: "withdraw" });

    await store
      .recordTerminal(TRANSFER, {
        status: "withdraw_failed",
        code: "GAS_EXCEEDS_REFUND",
        reason: "dust",
        recordedAtMs: 1,
      })
      .then(
        () => expect.fail("expected a refusal"),
        (err: Error) => expect(err.message).to.contain("refusing to write withdraw_failed over broadcast_pending")
      );
    expect((await store.read(TRANSFER))?.status).to.equal("broadcast_pending");
  });

  it("refuses to replace one terminal outcome with a different one", async function () {
    const store = new TransferStore(fakeRedis().redis);
    await store.recordTerminal(TRANSFER, EXECUTED);

    await store.recordTerminal(TRANSFER, { ...EXECUTED, status: "withdraw_executed" }).then(
      () => expect.fail("expected a refusal"),
      (err: Error) => expect(err.message).to.contain("refusing to write withdraw_executed over deposit_executed")
    );
  });

  it("records withdraw_failed when nothing was broadcast", async function () {
    const store = new TransferStore(fakeRedis().redis);
    await store.recordTerminal(TRANSFER, {
      status: "withdraw_failed",
      code: "UNPRICEABLE_REFUND_TOKEN",
      reason: "no price",
      recordedAtMs: 1,
    });
    expect((await store.read(TRANSFER))?.status).to.equal("withdraw_failed");
  });
});

describe("TransferStore redis failures", function () {
  it("reports a rejected redis command as a transient dependency failure", async function () {
    // Otherwise the raw client error escapes, and an unrecognised throw alerts — so an ordinary Redis
    // outage would page on every delivery instead of taking the debug-level retry path.
    const store = new TransferStore(fakeRedis([], { rejects: true }).redis);
    await store.read(TRANSFER).then(
      () => expect.fail("expected a failure"),
      (err: Error & { code?: string; retriable?: boolean }) => {
        expect(err.code).to.equal("TRANSIENT_DEPENDENCY_FAILURE");
        expect(err.retriable).to.equal(true);
        expect(err.message).to.contain("redis get failed");
      }
    );
  });
});

describe("TransferStore.clearRevertedBroadcast", function () {
  it("clears the record it was told about, so a reverted broadcast can be re-attempted", async function () {
    const store = new TransferStore(fakeRedis().redis);
    await store.recordBroadcast(TRANSFER, PENDING);

    expect(await store.clearRevertedBroadcast(TRANSFER, "0xh1")).to.equal(true);
    expect(await store.read(TRANSFER)).to.equal(undefined);
  });

  it("will not delete a newer pending transaction", async function () {
    // A stale reconciliation of h1 must not unblock a transfer that is mid-sweep on h2.
    const store = new TransferStore(fakeRedis().redis);
    await store.recordBroadcast(TRANSFER, { ...PENDING, txHash: "0xh2" });

    expect(await store.clearRevertedBroadcast(TRANSFER, "0xh1")).to.equal(false);
    expect((await store.read(TRANSFER))?.status).to.equal("broadcast_pending");
  });

  it("will not delete a terminal outcome", async function () {
    const store = new TransferStore(fakeRedis().redis);
    await store.recordTerminal(TRANSFER, EXECUTED);

    expect(await store.clearRevertedBroadcast(TRANSFER, "0xh1")).to.equal(false);
    expect((await store.read(TRANSFER))?.status).to.equal("deposit_executed");
  });

  it("is a no-op when there is nothing recorded", async function () {
    expect(await new TransferStore(fakeRedis().redis).clearRevertedBroadcast(TRANSFER, "0xh1")).to.equal(false);
  });
});

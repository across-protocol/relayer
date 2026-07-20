import sinon from "sinon";
import { expect } from "chai";
import { winston } from "../src/utils";
import { InstanceCoordinator } from "../src/utils/InstanceCoordinator";
import { RedisCacheInterface } from "../src/cache/Redis";

const IDENTIFIER = "test-deposit-address-handler";

/** Minimal in-memory stand-in for the Redis ops the coordinator uses (get/set). */
class FakeRedis {
  store = new Map<string, string>();

  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) ?? null) as T | null;
  }

  async set<T>(key: string, val: T): Promise<string> {
    this.store.set(key, String(val));
    return "OK";
  }
}

function makeCoordinator(
  redis: FakeRedis,
  instance: string,
  abortController = new AbortController()
): InstanceCoordinator {
  const logger = { debug: sinon.stub(), warn: sinon.stub(), error: sinon.stub() } as unknown as winston.Logger;
  return new InstanceCoordinator(
    logger,
    redis as unknown as RedisCacheInterface,
    IDENTIFIER,
    instance,
    abortController
  );
}

describe("InstanceCoordinator handover drain protocol", function () {
  afterEach(() => sinon.restore());

  it("initiateHandover returns undefined on a cold start and the predecessor on takeover", async function () {
    const redis = new FakeRedis();
    const a = makeCoordinator(redis, "instance-a");
    expect(await a.initiateHandover()).to.equal(undefined);
    expect(await a.isActiveInstance()).to.equal(true);

    const b = makeCoordinator(redis, "instance-b");
    expect(await b.initiateHandover()).to.equal("instance-a");
    expect(await b.isActiveInstance()).to.equal(true);
    expect(await a.isActiveInstance()).to.equal(false);
  });

  it("waitForPredecessorDrain returns true immediately when there is no predecessor", async function () {
    const redis = new FakeRedis();
    const b = makeCoordinator(redis, "instance-b");
    expect(await b.waitForPredecessorDrain(undefined, 0)).to.equal(true);
  });

  it("resolves true when the predecessor has already signalled drained", async function () {
    const redis = new FakeRedis();
    const a = makeCoordinator(redis, "instance-a");
    const b = makeCoordinator(redis, "instance-b");
    await a.initiateHandover();
    await b.initiateHandover();
    await a.signalDrained();
    expect(await b.waitForPredecessorDrain("instance-a", 0)).to.equal(true);
  });

  it("resolves true when the drained signal arrives while waiting", async function () {
    this.timeout(5000);
    const redis = new FakeRedis();
    const a = makeCoordinator(redis, "instance-a");
    const b = makeCoordinator(redis, "instance-b");
    const wait = b.waitForPredecessorDrain("instance-a", 3);
    setTimeout(() => void a.signalDrained(), 200);
    expect(await wait).to.equal(true);
  });

  it("returns false when the predecessor never signals within the timeout", async function () {
    const redis = new FakeRedis();
    const b = makeCoordinator(redis, "instance-b");
    expect(await b.waitForPredecessorDrain("instance-a", 0)).to.equal(false);
  });

  it("ignores a drained signal from a different instance", async function () {
    const redis = new FakeRedis();
    const stale = makeCoordinator(redis, "instance-stale");
    await stale.signalDrained();
    const b = makeCoordinator(redis, "instance-b");
    expect(await b.waitForPredecessorDrain("instance-a", 0)).to.equal(false);
  });

  it("returns false promptly when aborted", async function () {
    const redis = new FakeRedis();
    const abortController = new AbortController();
    const b = makeCoordinator(redis, "instance-b", abortController);
    abortController.abort();
    // Timeout is far in the future; only the abort can end the wait quickly.
    expect(await b.waitForPredecessorDrain("instance-a", 600)).to.equal(false);
  });
});

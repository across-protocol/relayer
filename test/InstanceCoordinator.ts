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

describe("InstanceCoordinator handover", function () {
  afterEach(() => sinon.restore());

  it("initiateHandover makes this instance active and displaces the predecessor", async function () {
    const redis = new FakeRedis();
    const a = makeCoordinator(redis, "instance-a");
    await a.initiateHandover();
    expect(await a.isActiveInstance()).to.equal(true);

    const b = makeCoordinator(redis, "instance-b");
    await b.initiateHandover();
    expect(await b.isActiveInstance()).to.equal(true);
    expect(await a.isActiveInstance()).to.equal(false);
    expect(await b.getActiveInstance()).to.equal("instance-b");
  });
});

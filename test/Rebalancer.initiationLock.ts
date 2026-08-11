import { expect } from "./utils";
import winston from "winston";
import { getRebalancerInitiationLockKey, withRebalancerInitiationLock } from "../src/rebalancer/utils/utils";

const TEST_LOGGER = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as winston.Logger;

const ACCOUNT = "0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D";

// In-memory Redis with SET NX lock semantics, shared between concurrent runs.
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
  } as never as Parameters<typeof withRebalancerInitiationLock>[3] & { locks: Map<string, string> };
}

describe("Rebalancer initiation lock", function () {
  it("serializes overlapping runs: the second is skipped, including its planning", async function () {
    const redis = makeRedis();
    let releaseFirst!: () => void;
    const firstRunning = new Promise<void>((resolve) => (releaseFirst = resolve));

    const first = withRebalancerInitiationLock(
      TEST_LOGGER,
      ACCOUNT,
      async () => {
        await firstRunning;
        return "first";
      },
      redis
    );
    await new Promise((resolve) => setImmediate(resolve));

    // The overlapping run is skipped outright: its planning callback never executes, so it cannot snapshot
    // balances that predate the first run's orders.
    let secondPlanned = false;
    const second = await withRebalancerInitiationLock(
      TEST_LOGGER,
      ACCOUNT,
      async () => {
        secondPlanned = true;
        return "second";
      },
      redis
    );
    expect(second).to.equal(undefined);
    expect(secondPlanned).to.equal(false);

    releaseFirst();
    expect(await first).to.equal("first");

    // The lock is released after the run completes, so the next run proceeds and replans from fresh state.
    expect(redis.locks.size).to.equal(0);
    expect(await withRebalancerInitiationLock(TEST_LOGGER, ACCOUNT, async () => "third", redis)).to.equal("third");
  });

  it("releases the lock when the run fails", async function () {
    const redis = makeRedis();

    await expect(
      withRebalancerInitiationLock(
        TEST_LOGGER,
        ACCOUNT,
        async () => {
          throw new Error("run failed");
        },
        redis
      )
    ).to.be.rejectedWith("run failed");
    expect(redis.locks.size).to.equal(0);
  });

  it("locks per account", async function () {
    const redis = makeRedis();
    const otherAccount = "0x0000000000000000000000000000000000000001";
    redis.locks.set(getRebalancerInitiationLockKey(otherAccount), "held-elsewhere");

    // Another account's run holding its own lock does not serialize this account's run.
    expect(await withRebalancerInitiationLock(TEST_LOGGER, ACCOUNT, async () => "ran", redis)).to.equal("ran");
  });

  it("runs unserialized when no status-tracking Redis is configured", async function () {
    // RELAYER_TEST disables Redis, so the default cache resolves to undefined and the run proceeds without a lock.
    expect(await withRebalancerInitiationLock(TEST_LOGGER, ACCOUNT, async () => "ran")).to.equal("ran");
  });
});

import { expect } from "./utils";

import { abortableDelay, fireAndForget, trackInFlight } from "../src/utils";

describe("Tasks", function () {
  describe("fireAndForget", function () {
    // fireAndForget returns synchronously; rejections settle on a later microtask.
    const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

    it("passes rejections to onError", async function () {
      const seen: unknown[] = [];
      const boom = new Error("boom");
      fireAndForget(
        () => Promise.reject(boom),
        (err) => seen.push(err)
      )();
      await flushMicrotasks();
      expect(seen).to.deep.equal([boom]);
    });

    it("swallows rejections when no onError is provided", async function () {
      // Must not surface as an unhandled rejection (which would crash the process).
      fireAndForget(() => Promise.reject(new Error("boom")))();
      await flushMicrotasks();
    });

    it("swallows a throwing onError handler", async function () {
      fireAndForget(
        () => Promise.reject(new Error("boom")),
        () => {
          throw new Error("handler boom");
        }
      )();
      await flushMicrotasks();
    });

    it("does not invoke onError when the task resolves", async function () {
      const seen: unknown[] = [];
      fireAndForget(
        () => Promise.resolve("ok"),
        (err) => seen.push(err)
      )();
      await flushMicrotasks();
      expect(seen).to.deep.equal([]);
    });
  });

  describe("abortableDelay", function () {
    it("resolves after roughly the requested delay when not aborted", async function () {
      const controller = new AbortController();
      const start = performance.now();
      await abortableDelay(0.25, controller.signal);
      const elapsedMs = performance.now() - start;
      expect(elapsedMs).to.be.greaterThanOrEqual(240);
      expect(elapsedMs).to.be.lessThan(1000);
    });

    it("returns early when the signal aborts mid-delay", async function () {
      const controller = new AbortController();
      const start = performance.now();
      setTimeout(() => controller.abort(), 50);
      await abortableDelay(10, controller.signal);
      const elapsedMs = performance.now() - start;
      expect(elapsedMs).to.be.lessThan(500);
    });

    it("returns immediately when the signal is already aborted", async function () {
      const controller = new AbortController();
      controller.abort();
      const start = performance.now();
      await abortableDelay(10, controller.signal);
      expect(performance.now() - start).to.be.lessThan(50);
    });

    it("removes its abort listener on normal completion", async function () {
      // Repeatedly running abortableDelay against the same signal must not accumulate listeners.
      // Spy on (add|remove)EventListener and assert net-zero outstanding 'abort' listeners.
      const controller = new AbortController();
      let added = 0;
      let removed = 0;
      const realAdd = controller.signal.addEventListener.bind(controller.signal);
      const realRemove = controller.signal.removeEventListener.bind(controller.signal);
      controller.signal.addEventListener = ((type: string, ...rest: unknown[]) => {
        if (type === "abort") {
          added++;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return realAdd(type as any, ...(rest as [any, any?]));
      }) as typeof controller.signal.addEventListener;
      controller.signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
        if (type === "abort") {
          removed++;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return realRemove(type as any, ...(rest as [any, any?]));
      }) as typeof controller.signal.removeEventListener;

      for (let i = 0; i < 25; i++) {
        await abortableDelay(0.001, controller.signal);
      }

      expect(added).to.equal(25);
      expect(removed).to.equal(25);
    });
  });

  describe("fireAndForget (onError logging pattern)", function () {
    // A macrotask tick to let the wrapped promise's `.catch` run before assertions.
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

    it("logs a rejected task at error level when onError logs via a logger (ACB-552)", async function () {
      const errors: Record<string, unknown>[] = [];
      const logger = { error: (info: Record<string, unknown>) => errors.push(info) };
      const boom = new Error("boom");

      fireAndForget(
        () => Promise.reject(boom),
        (err) =>
          logger.error({
            at: "TestTask",
            error: err,
          })
      )();
      await tick();

      expect(errors).to.have.length(1);
      expect(errors[0].at).to.equal("TestTask");
      expect(errors[0].error).to.equal(boom);
    });

    it("does not invoke the logger when the task resolves", async function () {
      const errors: unknown[] = [];
      const logger = { error: (info: Record<string, unknown>) => errors.push(info) };

      fireAndForget(
        () => Promise.resolve("ok"),
        (err) => logger.error({ error: err })
      )();
      await tick();

      expect(errors).to.have.length(0);
    });

    it("never throws synchronously and swallows rejections when no onError is given", async function () {
      const cb = fireAndForget(() => Promise.reject(new Error("boom")));
      expect(cb).to.not.throw();
      await tick();
    });
  });

  describe("trackInFlight", function () {
    // Tracking settles invocations over a few microtask hops; setImmediate flushes them all.
    const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

    it("drains every overlapping invocation, not only the most recent", async function () {
      // scheduleTask is fixed-rate, so invocation 1 can still be running when invocation 2 starts
      // and finishes. Draining must wait for the older one.
      const releases: Array<() => void> = [];
      const { run, drain } = trackInFlight(() => new Promise<void>((resolve) => releases.push(resolve)));

      const first = run();
      const second = run();
      let firstSettled = false;
      void first.then(() => (firstSettled = true));

      releases[1]();
      await second;
      await flushMicrotasks();

      let drained: boolean | undefined;
      void drain(10).then((result) => (drained = result));
      await flushMicrotasks();
      expect(drained).to.be.undefined;
      expect(firstSettled).to.be.false;

      releases[0]();
      await first;
      await flushMicrotasks();
      expect(drained).to.be.true;
    });

    it("returns false once the drain bound expires", async function () {
      const { run, drain } = trackInFlight(() => new Promise<void>(() => undefined)); // Never settles.
      void run();
      const start = performance.now();
      expect(await drain(0.1)).to.be.false;
      expect(performance.now() - start).to.be.lessThan(1000);
    });

    it("returns true when nothing is in flight", async function () {
      const { run, drain } = trackInFlight(async () => undefined);
      await run();
      await flushMicrotasks();
      expect(await drain(10)).to.be.true;
    });

    it("stops tracking a rejected invocation without an unhandled rejection", async function () {
      const { run, drain } = trackInFlight(() => Promise.reject(new Error("boom")));
      let rejected = false;
      // The caller still sees the rejection (scheduleTask's onError reports it).
      await run().catch(() => (rejected = true));
      await flushMicrotasks();
      expect(rejected).to.be.true;
      expect(await drain(10)).to.be.true;
    });
  });
});

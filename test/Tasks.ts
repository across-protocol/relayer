import { expect } from "./utils";

import { abortableDelay, fireAndForget } from "../src/utils";

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
});

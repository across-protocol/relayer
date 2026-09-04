/**
 * Wrap an async task as a fire-and-forget callback for `setTimeout`/`setInterval` slots
 * that expect `() => void`. Rejections can't crash the process via an unhandled rejection:
 * they are passed to `onError` when provided, otherwise swallowed. Prefer passing `onError` —
 * a recurring task that fails silently on every tick is invisible until its downstream effects
 * are (2026-07-15 deposit-address incident).
 * @param onError Optional rejection handler. Must not throw; if it does, the error is swallowed.
 */
export function fireAndForget(task: () => Promise<unknown>, onError?: (err: unknown) => void): () => void {
  return () =>
    void task().catch((err) => {
      try {
        onError?.(err);
      } catch {
        // A throwing error handler must not crash the process either.
      }
    });
}

/**
 * Sleep for `seconds`, returning early if `signal` aborts. Clears the pending timer on abort
 * (so it doesn't keep the event loop alive past shutdown) and detaches the abort listener on
 * normal completion (so listeners don't accumulate when called in a retry loop).
 */
export function abortableDelay(seconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, seconds * 1000);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Schedule a recurring task, to be executed `interval` seconds after each successive call.
 * @param task Function that returns a Promise to be awaited.
 * @param interval Task interval.
 * @param onError Optional per-tick rejection handler (see fireAndForget). Failures never stop the schedule.
 */
export function scheduleTask(
  task: () => Promise<unknown>,
  interval: number,
  signal: AbortSignal,
  onError?: (err: unknown) => void
): void {
  const timer = setInterval(fireAndForget(task, onError), interval * 1000);
  signal.addEventListener("abort", () => clearInterval(timer));
}

/**
 * Tracks every in-flight invocation of a recurring task so that shutdown can wait for them.
 * `scheduleTask` is fixed-rate (`setInterval`), so an invocation which outruns its interval overlaps
 * with its successors; retaining only the newest promise would let teardown proceed while an older
 * invocation is still running (e.g. still submitting transactions through clients about to close).
 * @param task Task to wrap. Pass the returned `run` to `scheduleTask` in the task's place.
 * @returns `run`, which invokes and tracks `task`, and `drain` (see below).
 */
export function trackInFlight(task: () => Promise<unknown>): {
  run: () => Promise<unknown>;
  drain: (timeoutSeconds: number) => Promise<boolean>;
} {
  const inFlight = new Set<Promise<unknown>>();

  return {
    run: () => {
      const invocation = task();
      inFlight.add(invocation);
      // Rejections are the caller's business (see fireAndForget's onError); swallow them here so
      // that tracking an invocation can never itself raise an unhandled rejection.
      void invocation.catch(() => undefined).finally(() => inFlight.delete(invocation));
      return invocation;
    },

    /**
     * Waits for all currently in-flight invocations to settle.
     * @returns true if they all settled, false if `timeoutSeconds` expired with any still running.
     */
    drain: async (timeoutSeconds: number): Promise<boolean> => {
      if (inFlight.size === 0) {
        return true;
      }
      const settled = Promise.all([...inFlight].map((invocation) => invocation.catch(() => undefined))).then(
        () => true
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expiry = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutSeconds * 1000);
      });
      try {
        return await Promise.race([settled, expiry]);
      } finally {
        // Don't keep the event loop alive past shutdown once the race is decided.
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Schedule a recurring task using recursive setTimeout, ensuring calls never overlap.
 * The next invocation is scheduled only after the current one completes (or fails).
 * Failures are logged as warnings and never prevent rescheduling.
 * @param name Human-readable task identifier for log messages.
 * @param logger Winston logger instance.
 * @param task Function that returns a Promise to be awaited.
 * @param interval Minimum delay between completions, in seconds.
 * @param signal AbortSignal for cancellation; pending timers are cleared on abort.
 */
export function scheduleSequentialTask(
  name: string,
  logger: { warn: (info: Record<string, unknown>) => unknown },
  task: () => Promise<unknown>,
  interval: number,
  signal: AbortSignal
): void {
  let timer: ReturnType<typeof setTimeout>;
  const runOnce = async () => {
    try {
      await task();
    } catch (err) {
      logger.warn({
        at: "scheduleSequentialTask",
        message: `${name} update failed.`,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    if (!signal.aborted) {
      schedule();
    }
  };
  const schedule = () => {
    timer = setTimeout(() => void runOnce(), interval * 1000);
  };
  signal.addEventListener("abort", () => clearTimeout(timer));
  schedule();
}

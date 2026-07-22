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
  // A signal that aborted in the past never fires "abort" again, so the interval would never be
  // cleared when scheduling starts after shutdown was already observed. Schedule nothing instead.
  if (signal.aborted) {
    return;
  }
  const timer = setInterval(fireAndForget(task, onError), interval * 1000);
  signal.addEventListener("abort", () => clearInterval(timer));
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

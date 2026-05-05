/**
 * Wrap an async task as a fire-and-forget callback for `setTimeout`/`setInterval` slots
 * that expect `() => void`. Rejections are swallowed so a failed task can't crash the process
 * via an unhandled rejection.
 */
export function fireAndForget(task: () => Promise<unknown>): () => void {
  return () => void task().catch(() => undefined);
}

/**
 * Schedule a recurring task, to be executed `interval` seconds after each successive call.
 * @param task Function that returns a Promise to be awaited.
 * @param interval Task interval.
 */
export function scheduleTask(task: () => Promise<unknown>, interval: number, signal: AbortSignal): void {
  const timer = setInterval(fireAndForget(task), interval * 1000);
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

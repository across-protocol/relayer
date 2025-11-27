/**
 * Schedule a recurring task, to be executed `interval` seconds after each successive call.
 * @param task Promise to be awaited.
 * @param interval Task interval.
 */
export function scheduleTask(task: Promise<unknown>, interval: number, signal: AbortSignal): void {
  const timer = setInterval(async () => await task, interval * 1000);
  signal.addEventListener("abort", () => clearTimeout(timer));
}

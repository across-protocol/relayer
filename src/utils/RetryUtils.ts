import { delay } from "./SDKUtils";

export function retryAsync<T, U extends unknown[]>(
  fn: (...args: U) => Promise<T>,
  numRetries: number,
  delayS: number,
  ...args: U
): Promise<T> {
  let ret = fn(...args);
  for (let i = 0; i < numRetries; i++) {
    ret = ret.catch(async () => {
      await delay(delayS);
      return fn(...args);
    });
  }
  return ret;
}

// Exponential backoff with jitter and a cap
export function backoffWithJitter(retry: number, baseDelayMs = 50, backoffExponentBase = 2, maxDelayMs = 5000) {
  const baseDelay = baseDelayMs * backoffExponentBase ** retry;
  const jitter = (0.5 - Math.random()) * baseDelay;
  const delay = baseDelay + jitter;
  const base = Math.min(delay, maxDelayMs);
  return base + jitter;
}

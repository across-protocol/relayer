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

import { delay } from "./TimeUtils";

export async function retryAsync<T>(fn: () => Promise<T>, numRetries: number, delayS: number): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (numRetries <= 0) {
      throw err;
    }
    await delay(delayS);
    return retryAsync(fn, numRetries - 1, delayS);
  }
}

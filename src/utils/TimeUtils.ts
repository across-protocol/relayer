/**
 * Get time in same unit (seconds) as on-chain block timestamps.
 * @returns The current time in seconds
 */
export function getCurrentTime(): number {
  return Math.round(Date.now().valueOf() / 1000);
}

export function delay(s: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, Math.round(s * 1000)));
}

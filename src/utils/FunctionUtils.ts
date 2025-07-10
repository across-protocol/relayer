export async function waitUntilTrue(
  checkCondition: () => Promise<boolean>,
  intervalMs: number,
  maxWaitMs = 60000
): Promise<boolean> {
  const startTime = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await checkCondition();
    if (result) {
      return true;
    }
    if (Date.now() - startTime > maxWaitMs) {
      return false;
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

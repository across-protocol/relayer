export async function waitUntilTrue(checkCondition: () => Promise<boolean>, intervalMs: number): Promise<void> {
  while (true) {
    const result = await checkCondition();
    if (result) break;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

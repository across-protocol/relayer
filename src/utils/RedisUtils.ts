import { createClient } from "redis4";


export async function getFromCache(key: string, redisClient?: ReturnType<typeof createClient>): Promise<string | null> {
  if (!redisClient) return null;
  return redisClient.get(key); // Returns null if key doesn't exist in cache
}

export async function setInCache(
  key: string,
  value: string,
  redisClient?: ReturnType<typeof createClient>
): Promise<void> {
  if (!redisClient) return;
  await redisClient.set(key, value);
}

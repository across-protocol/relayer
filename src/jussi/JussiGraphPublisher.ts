import { randomUUID } from "node:crypto";
import winston from "winston";
import { RedisCacheInterface } from "../cache/Redis";
import { JussiApiClient } from "./JussiApiClient";
import { buildJussiGraphBundleJson, buildJussiGraphId, bundleHash } from "./serialize";
import { BuiltJussiGraph } from "./types";

export const JUSSI_LAST_PUBLISHED_KEY = "jussi:graph:last_published";
export const JUSSI_PUBLISH_LOCK_KEY = "jussi:graph:publish:lock";
const JUSSI_PUBLISH_PREFLIGHT_KEY = "jussi:graph:publish:preflight";
const DEFAULT_PUBLISH_LOCK_TTL_MS = 10 * 60 * 1000;

export type JussiPublisherRedis = Pick<
  RedisCacheInterface,
  "acquireLock" | "del" | "get" | "releaseLock" | "renewLock" | "set"
>;
export type JussiUploadResult = {
  uploaded: true;
  graphId: string;
  bundleHash: string;
};

export function validateJussiUploadEnv(env: NodeJS.ProcessEnv): URL {
  const rawUrl = env.JUSSI_API_URL;
  if (!rawUrl) {
    throw new Error("JUSSI_API_URL must be set for --upload");
  }
  const url = new URL(rawUrl);
  const isLocalhost = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (!isLocalhost && env.JUSSI_ALLOW_PROD_UPLOAD !== "true") {
    throw new Error("Refusing non-localhost Jussi upload without JUSSI_ALLOW_PROD_UPLOAD=true");
  }
  return url;
}

export class JussiGraphPublisher {
  constructor(
    private readonly params: {
      apiClient: JussiApiClient;
      logger: winston.Logger;
      redis: JussiPublisherRedis;
      runFullBuild: (graphId: string) => Promise<BuiltJussiGraph>;
      lockTtlMs?: number;
      now?: () => Date;
    }
  ) {}

  async publishUpload(): Promise<JussiUploadResult> {
    const lockTtlMs = this.params.lockTtlMs ?? DEFAULT_PUBLISH_LOCK_TTL_MS;
    const token = randomUUID();
    await this.preflightRedis(token);
    if (!(await this.params.redis.acquireLock(JUSSI_PUBLISH_LOCK_KEY, token, lockTtlMs))) {
      throw new Error(`Could not acquire ${JUSSI_PUBLISH_LOCK_KEY}`);
    }

    let heartbeatError: Error | undefined;
    const heartbeat = setInterval(
      () => {
        void this.params.redis
          .renewLock(JUSSI_PUBLISH_LOCK_KEY, token, lockTtlMs)
          .then((renewed) => {
            if (!renewed) {
              heartbeatError = new Error(`Lost ${JUSSI_PUBLISH_LOCK_KEY}`);
            }
          })
          .catch((error) => {
            heartbeatError = error instanceof Error ? error : new Error(String(error));
          });
      },
      Math.max(1, Math.floor(lockTtlMs / 3))
    );

    const graphId = buildJussiGraphId(this.params.now?.() ?? new Date());
    let hash: string | undefined;
    let didPut = false;
    try {
      const builtGraph = await this.params.runFullBuild(graphId);
      if (heartbeatError) {
        throw heartbeatError;
      }
      const bundle = buildJussiGraphBundleJson(builtGraph);
      hash = bundleHash(bundle);
      if (heartbeatError) {
        throw heartbeatError;
      }
      // Re-check ownership immediately before the PUT: the lock can be lost during the gap
      // between finishing the build and issuing the upload, and we must not PUT while another
      // publisher may already hold the lock.
      await this.renewPublishLockOrThrow(token, lockTtlMs);
      await this.params.apiClient.putGraphBundle(graphId, bundle);
      didPut = true;
      await this.persistMetadata(graphId, hash);

      return {
        uploaded: true,
        graphId,
        bundleHash: hash,
      };
    } catch (error) {
      if (didPut && hash) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Jussi upload metadata failure for graphId=${graphId} bundleHash=${hash}: ${message}`);
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      await this.params.redis.releaseLock(JUSSI_PUBLISH_LOCK_KEY, token).catch((error) => {
        this.params.logger.warn({
          at: "JussiGraphPublisher.publishUpload",
          message: "Failed to release publish lock",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private async preflightRedis(token: string): Promise<void> {
    await this.params.redis.set(JUSSI_PUBLISH_PREFLIGHT_KEY, token, 5);
    const value = await this.params.redis.get<string>(JUSSI_PUBLISH_PREFLIGHT_KEY);
    await this.params.redis.del(JUSSI_PUBLISH_PREFLIGHT_KEY);
    if (value !== token) {
      throw new Error("Redis preflight failed for Jussi graph publisher");
    }
  }

  private async renewPublishLockOrThrow(token: string, lockTtlMs: number): Promise<void> {
    if (!(await this.params.redis.renewLock(JUSSI_PUBLISH_LOCK_KEY, token, lockTtlMs))) {
      throw new Error(`Lost ${JUSSI_PUBLISH_LOCK_KEY}`);
    }
  }

  private async persistMetadata(graphId: string, hash: string): Promise<void> {
    const publishedAt = (this.params.now?.() ?? new Date()).toISOString();
    // Intentionally persisted without a TTL (Number.POSITIVE_INFINITY): jussi:graph:last_published
    // is the durable record of the most recently published graph and must survive indefinitely so
    // operators can always reconcile the live Jussi state against the last upload. It is overwritten
    // (not appended) on every successful publish.
    await this.params.redis.set(
      JUSSI_LAST_PUBLISHED_KEY,
      JSON.stringify({
        graphId,
        bundleHash: hash,
        publishedAt,
      }),
      Number.POSITIVE_INFINITY
    );
  }
}

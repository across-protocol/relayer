import { PubSub } from "@google-cloud/pubsub";
import winston from "winston";
import { isDefined } from "../../utils/TypeGuards";

/**
 * GcpPubSubPublisher wraps a Google Cloud Pub/Sub `PubSub` client and publishes JSON-encoded
 * messages to a topic. The client library handles batching, retries, and ADC-based auth on
 * its own; this wrapper exists so call sites get consistent logging and a `close()` shape
 * that matches the Redis pub/sub helper.
 *
 * Auth uses Application Default Credentials. In Cloud Run / GKE the runtime service account
 * supplies them automatically; locally, set `GOOGLE_APPLICATION_CREDENTIALS` to a key file
 * with `roles/pubsub.publisher` on the target topic.
 *
 * `projectId` should be the project that *hosts the topic*, which may differ from the
 * project the bot runs in (cross-project publish is supported when the runtime SA has
 * publisher rights on the topic in the host project).
 */
export class GcpPubSubPublisher {
  constructor(
    private readonly client: PubSub,
    private readonly projectId: string,
    private readonly logger?: winston.Logger
  ) {}

  /**
   * Publishes a JSON-encoded message to `topicName`. Returns the GCP-assigned message id.
   * Throws if the client library exhausts its internal retries.
   */
  async publishJson(topicName: string, payload: unknown): Promise<string> {
    const data = Buffer.from(JSON.stringify(payload), "utf8");
    const messageId = await this.client.topic(topicName).publishMessage({ data });
    return messageId;
  }

  async close(): Promise<void> {
    try {
      await this.client.close();
    } catch (err) {
      this.logger?.warn({
        at: "GcpPubSubPublisher#close",
        message: "Error closing GCP Pub/Sub client",
        projectId: this.projectId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Builds a {@link GcpPubSubPublisher} bound to `projectId`. Returns `undefined` when
 * running in test mode or when `projectId` is missing — callers must null-check.
 *
 * Mirrors the test short-circuit in `src/messaging/redis/PubSub.ts#getRedisPubSub`.
 */
export function getGcpPubSubPublisher(logger?: winston.Logger, projectId?: string): GcpPubSubPublisher | undefined {
  if (isDefined(process.env.RELAYER_TEST)) {
    return undefined;
  }
  if (!isDefined(projectId) || projectId.length === 0) {
    return undefined;
  }
  const client = new PubSub({ projectId });
  return new GcpPubSubPublisher(client, projectId, logger);
}

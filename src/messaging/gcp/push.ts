/**
 * The JSON body Pub/Sub POSTs to a push endpoint. Everything is optional: this arrives over HTTP and
 * none of it is guaranteed.
 *
 * Not `protos.google.pubsub.v1.IPubsubMessage` — that types `publishTime` as an `ITimestamp`, whereas
 * proto3 JSON mapping puts an RFC3339 string on the wire. `deliveryAttempt` is only populated when the
 * subscription has a dead-letter policy.
 */
export interface PubSubPushMessage {
  message?: {
    data?: string;
    messageId?: string;
    publishTime?: string;
    orderingKey?: string;
    attributes?: Record<string, string>;
  };
  subscription?: string;
  deliveryAttempt?: number;
}

/**
 * Decodes base64 `data` to its UTF-8 payload; `undefined` when absent, not a string, empty, or
 * whitespace-only. Pub/Sub allows attribute-only messages, so the caller decides if that is an error.
 *
 * Takes `unknown` and checks the type rather than trusting a cast: `Buffer.from` **throws** on a number
 * or object, and silently reads an array as raw bytes. A throw here would escape the caller's ACK/NACK
 * policy entirely.
 */
export function decodePubSubData(data: unknown): string | undefined {
  if (typeof data !== "string" || data.length === 0) {
    return undefined;
  }

  const payload = Buffer.from(data, "base64").toString("utf8").trim();
  return payload.length > 0 ? payload : undefined;
}

/**
 * The raw JSON body Pub/Sub POSTs to a push endpoint: everything optional, nothing guaranteed.
 *
 * Use this only for best-effort logging on paths that reject a delivery. Anything that proceeds should
 * go through {@link decodePushDelivery} and carry a {@link PushDelivery} instead, so no downstream code
 * has to optional-chain transport fields.
 *
 * Not `protos.google.pubsub.v1.IPubsubMessage` — that types `publishTime` as an `ITimestamp`, whereas
 * proto3 JSON mapping puts an RFC3339 string on the wire.
 */
export interface PubSubPushMessage {
  message?: { data?: unknown; messageId?: unknown; publishTime?: unknown; orderingKey?: unknown; attributes?: unknown };
  subscription?: unknown;
  deliveryAttempt?: unknown;
}

/**
 * A push delivery whose transport contract has been checked: the payload decoded and the identity is
 * present. Business validation of the payload is a separate concern.
 *
 * `messageId` is required because without a dead-letter policy Pub/Sub omits `deliveryAttempt`, leaving
 * it as the only way to correlate a redelivery with earlier attempts. The remaining metadata is
 * diagnostic, so it stays optional — a delivery is never rejected over a field we do not depend on, and
 * one arriving with the wrong type is dropped rather than allowed to poison the log line.
 */
export interface PushDelivery {
  readonly payload: string;
  readonly messageId: string;
  readonly publishTime?: string;
  readonly orderingKey?: string;
  readonly subscription?: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly deliveryAttempt?: number;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStringMap(value: unknown): Record<string, string> {
  const source = asObject(value) ?? {};
  return Object.fromEntries(Object.entries(source).filter(([, v]) => typeof v === "string")) as Record<string, string>;
}

/**
 * Whether the body is a Pub/Sub push envelope at all. Distinguishes "not from Pub/Sub" — safely
 * answerable with a 4xx, since no subscription will retry it — from a real delivery we cannot use,
 * which must be acknowledged rather than redelivered forever.
 */
export function isPushRequest(body: unknown): boolean {
  return asObject(asObject(body)?.message) !== undefined;
}

/**
 * Validates the transport contract and returns a trusted delivery, or `undefined` when the envelope
 * cannot produce one — absent, non-string, or empty `data`, or a missing `messageId`.
 *
 * `data` is deliberately typed `unknown` and checked: `Buffer.from` **throws** on a number or object,
 * and silently reads an array as raw bytes. A throw here would escape the caller's ACK/NACK policy.
 */
export function decodePushDelivery(body: unknown): PushDelivery | undefined {
  const message = asObject(asObject(body)?.message);
  if (message === undefined) {
    return undefined;
  }

  const data = asString(message.data);
  const messageId = asString(message.messageId);
  if (data === undefined || messageId === undefined) {
    return undefined;
  }

  const payload = Buffer.from(data, "base64").toString("utf8").trim();
  if (payload.length === 0) {
    return undefined;
  }

  const deliveryAttempt = asObject(body)?.deliveryAttempt;
  return {
    payload,
    messageId,
    publishTime: asString(message.publishTime),
    orderingKey: asString(message.orderingKey),
    subscription: asString(asObject(body)?.subscription),
    attributes: asStringMap(message.attributes),
    deliveryAttempt: typeof deliveryAttempt === "number" ? deliveryAttempt : undefined,
  };
}

// Transport-agnostic messaging primitives. Callers must not assume any
// specific transport (Redis Streams, NATS, Kafka, in-memory mock, ...).

export interface PublishOptions {
  // Retain at most ~this many entries; transports may apply approximately.
  maxLen?: number;
}

export interface SubscribeOptions {
  // Consumer-group identity; stable across calls.
  group: string;
  // Consumer-name within the group; unique per concurrent instance.
  consumer: string;
  // Block up to this many ms waiting for messages.
  blockMs?: number;
  // Max entries returned per fetch.
  count?: number;
  // External cancellation; exits `messages()` at the next loop boundary.
  signal?: AbortSignal;
}

export interface DeliveredMessage {
  // Transport-opaque id.
  id: string;
  // Opaque payload; caller (de)serialises.
  payload: string;
  // Acknowledge successful processing; broker will not redeliver.
  ack(): Promise<void>;
  // Optional: request earlier redelivery. Transports without native NACK omit.
  nack?(): Promise<void>;
}

export interface Subscription {
  // Async-iterable of delivered messages. Each yields once; unacked entries
  // are redelivered after a transport-specific idle period. Single-consumer.
  messages(): AsyncIterable<DeliveredMessage>;
  close(): Promise<void>;
}

export interface MessageStream {
  // Append a payload; returns the broker-assigned id.
  publish(topic: string, payload: string, opts?: PublishOptions): Promise<string>;
  // Begin a durable subscription. Auto-creates the topic and group if absent.
  subscribe(topic: string, opts: SubscribeOptions): Promise<Subscription>;
  disconnect(): Promise<void>;
}

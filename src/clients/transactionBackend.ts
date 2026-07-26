// Broker submission backend. Active when TRANSACTION_CLIENT_BROADCAST=redis.
// Publishes SubmissionRequests to the per-EOA request topic, listens on the
// per-EOA response topic for ack + final messages, dispatches them to pending
// entries by request id, and synthesises an ethers TransactionResponse for
// callers. Direct-RPC submission paths in TransactionClient are untouched.

import { BigNumber, ethers } from "ethers";
import { Log, TransactionReceipt, TransactionResponse } from "@ethersproject/abstract-provider";
import { randomUUID } from "crypto";
import winston from "winston";
import { isDefined } from "../utils";
import { getRedisPubSub, RedisPubSub } from "../messaging/redis/PubSub";
import {
  AckMessage,
  decodeResponse,
  encodeRequest,
  FinalMessage,
  ResponseMessage,
  SubmissionRequest,
  TransactionReceiptLite,
} from "../transactionManager/wire";
import type { AugmentedTransaction } from "./TransactionClient";

// Module-level state. Bot startup calls `initTransactionBackend` to populate.
// `new TransactionClient(logger)` picks these up via accessors below.
// Redis forbids PUBLISH on a connection in SUBSCRIBE state, so producer and
// subscriber must own distinct sockets.
let _broadcastMode: "rpc" | "redis" = "rpc";
let _sharedBackend: Backend | undefined;
let _sharedPublisher: RedisPubSub | undefined;
let _sharedSubscriber: RedisPubSub | undefined;

export function broadcastMode(): "rpc" | "redis" {
  return _broadcastMode;
}
export function sharedBackend(): Backend | undefined {
  return _sharedBackend;
}

export async function initTransactionBackend(
  logger: winston.Logger,
  broadcast: "rpc" | "redis",
  callerId: string
): Promise<void> {
  _broadcastMode = broadcast;
  if (broadcast !== "redis" || isDefined(_sharedBackend)) {
    return;
  }

  const publisher = await getRedisPubSub(logger);
  const subscriber = await getRedisPubSub(logger);
  if (!isDefined(publisher) || !isDefined(subscriber)) {
    return;
  } // RELAYER_TEST or other opt-out
  _sharedPublisher = publisher;
  _sharedSubscriber = subscriber;
  _sharedBackend = new Backend(publisher, subscriber, logger, { callerId });
}

export async function disposeTransactionBackend(): Promise<void> {
  if (isDefined(_sharedBackend)) {
    await _sharedBackend.disconnect();
  }
  await Promise.allSettled([_sharedPublisher?.disconnect(), _sharedSubscriber?.disconnect()]);
  _sharedBackend = undefined;
  _sharedPublisher = undefined;
  _sharedSubscriber = undefined;
  _broadcastMode = "rpc";
}

// Topic naming.
const REQUEST_TOPIC_PREFIX = "txn:requests";
const RESPONSE_TOPIC_PREFIX = "txn:responses";

export function requestTopic(chainId: number, eoa: string): string {
  return `${REQUEST_TOPIC_PREFIX}:${chainId}:${eoa.toLowerCase()}`;
}

export function responseTopic(chainId: number, eoa: string): string {
  return `${RESPONSE_TOPIC_PREFIX}:${chainId}:${eoa.toLowerCase()}`;
}

function subscriptionKey(chainId: number, eoa: string): string {
  return `${chainId}:${eoa.toLowerCase()}`;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  // Default no-op assignments; the Promise executor runs synchronously and
  // overwrites both before the constructor returns.
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface PendingEntry {
  ack: Deferred<AckMessage>;
  final: Deferred<FinalMessage>;
  eoa: string;
  to: string;
  chainId: number;
}

type Listener = (payload: string, topic: string) => void;

interface SubscriptionRecord {
  topic: string;
  listener: Listener;
}

export interface BackendOptions {
  // Identifier surfaced in logs; helps disambiguate concurrent caller processes.
  callerId: string;
}

// Minimum pubsub surface the Backend uses; satisfied by RedisPubSub and by
// test in-memory stand-ins. Avoids coupling tests to the concrete Redis class.
export interface BackendPubSub {
  pub(topic: string, message: string): Promise<number>;
  sub(topic: string, listener: (message: string, topic: string) => void): Promise<void>;
  unsub(topic: string, listener: (message: string, topic: string) => void): Promise<void>;
}

/**
 * Broker submission backend. Caller-facing return is a synthesised ethers
 * `TransactionResponse` whose `.wait()` awaits the manager's final message —
 * callers don't see the wire envelope, only the same handle shape as the
 * direct-RPC path.
 */
export class Backend {
  // Keyed by `<chainId>:<eoa>` — each pair subscribes once to its response topic.
  private readonly subscribed = new Map<string, SubscriptionRecord>();
  // Race-dedup for concurrent first submits on a new (chain, eoa).
  private readonly subscribingPromises = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, PendingEntry>();
  private readonly abortController = new AbortController();

  constructor(
    private readonly publisher: BackendPubSub,
    private readonly subscriber: BackendPubSub,
    private readonly logger: winston.Logger,
    private readonly opts: BackendOptions
  ) {}

  async submit(txn: AugmentedTransaction): Promise<TransactionResponse> {
    if (this.abortController.signal.aborted) {
      throw new Error("Backend is closed");
    }
    const eoa = await txn.contract.signer.getAddress();
    await this.ensureSubscription(txn.chainId, eoa);

    const id = randomUUID();
    const request = this.buildRequest(id, txn);

    const ackD = deferred<AckMessage>();
    const finalD = deferred<FinalMessage>();
    this.pending.set(id, {
      ack: ackD,
      final: finalD,
      eoa,
      to: txn.contract.address,
      chainId: txn.chainId,
    });

    try {
      await this.publisher.pub(requestTopic(txn.chainId, eoa), encodeRequest(request));
    } catch (err) {
      this.pending.delete(id);
      throw err;
    }

    const ack = await ackD.promise;
    if (ack.ok === false) {
      this.pending.delete(id);
      throw new Error(`TransactionManager rejected request (${ack.reason}): ${ack.error}`);
    }

    return this.toResponse(ack, txn, eoa, finalD.promise);
  }

  async disconnect(): Promise<void> {
    this.abortController.abort();
    for (const { topic, listener } of this.subscribed.values()) {
      await this.subscriber.unsub(topic, listener);
    }
    this.subscribed.clear();
    this.subscribingPromises.clear();
    const reason = new Error("Backend closed");
    for (const entry of this.pending.values()) {
      entry.ack.reject(reason);
      entry.final.reject(reason);
    }
    this.pending.clear();
  }

  private async ensureSubscription(chainId: number, eoa: string): Promise<void> {
    const key = subscriptionKey(chainId, eoa);
    if (this.subscribed.has(key)) {
      return;
    }
    let pending = this.subscribingPromises.get(key);
    if (!pending) {
      pending = (async () => {
        const topic = responseTopic(chainId, eoa);
        const listener: Listener = (payload) => {
          if (this.abortController.signal.aborted) {
            return;
          }
          try {
            this.handleResponse(decodeResponse(payload));
          } catch (err) {
            this.logger.warn({
              at: "Backend#listener",
              message: "Decode failed",
              chainId,
              eoa,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        };
        await this.subscriber.sub(topic, listener);
        this.subscribed.set(key, { topic, listener });
      })();
      this.subscribingPromises.set(key, pending);
    }
    await pending;
  }

  private handleResponse(msg: ResponseMessage): void {
    const entry = this.pending.get(msg.id);
    if (!entry) {
      // Either not ours, or already resolved and removed.
      return;
    }
    if (msg.phase === "ack") {
      entry.ack.resolve(msg);
      // ACK failures are terminal — no `final` will follow. Reject the final
      // promise to unblock any caller that already called .wait().
      if (msg.ok === false) {
        entry.final.reject(new Error(`TransactionManager rejected request (${msg.reason}): ${msg.error}`));
        this.pending.delete(msg.id);
      }
      return;
    }
    // phase === "final"
    entry.final.resolve(msg);
    this.pending.delete(msg.id);
  }

  private buildRequest(id: string, txn: AugmentedTransaction): SubmissionRequest {
    // superstruct 1.x's `optional()` doesn't lift fields to TS-optional in
    // Infer; provide every field explicitly with `undefined` for unset ones.
    return {
      id,
      chainId: txn.chainId,
      to: txn.contract.address,
      abi: extractMethodAbi(txn),
      method: txn.method,
      args: normaliseArgs(txn.args),
      value: txn.value !== undefined ? txn.value.toHexString() : undefined,
      gasLimit: txn.gasLimit !== undefined ? txn.gasLimit.toHexString() : undefined,
      gasLimitMultiplier: txn.gasLimitMultiplier,
      confirmations: undefined,
      message: txn.message,
      mrkdwn: txn.mrkdwn,
    };
  }

  private toResponse(
    ack: AckMessage & { ok: true },
    txn: AugmentedTransaction,
    eoa: string,
    finalPromise: Promise<FinalMessage>
  ): TransactionResponse {
    const wait = async (_confirmations?: number): Promise<TransactionReceipt> => {
      const final = await finalPromise;
      if (final.ok === false) {
        throw new Error(`TransactionManager confirmation failed (${final.reason}): ${final.error}`);
      }
      return synthesiseReceipt(final.hash, eoa, txn.contract.address, final.receipt);
    };

    // Synthesised; only `.hash` and `.wait()` are load-bearing for callers
    // today (see MultiCallerClient, Refiller). Other fields are filled with
    // honest placeholders.
    const response = {
      hash: ack.hash,
      nonce: ack.nonce,
      from: eoa,
      to: txn.contract.address,
      chainId: txn.chainId,
      data: "0x",
      value: txn.value ?? BigNumber.from(0),
      gasLimit: txn.gasLimit ?? BigNumber.from(0),
      gasPrice: BigNumber.from(0),
      confirmations: 0,
      r: "0x",
      s: "0x",
      v: 0,
      type: 0,
      wait,
    };
    return response as unknown as TransactionResponse;
  }
}

function extractMethodAbi(txn: AugmentedTransaction): unknown[] {
  if (txn.method === "") {
    return [];
  }
  try {
    const fragment = txn.contract.interface.getFunction(txn.method);
    // fragment.format("json") yields a bare object; wrap so the manager's `new Contract(to, abi, ...)` accepts it.
    return [JSON.parse(fragment.format(ethers.utils.FormatTypes.json))];
  } catch {
    return [];
  }
}

// Recurse before JSON.stringify: BigNumber.prototype.toJSON runs before any
// replacer would, so we'd otherwise ship `{type:"BigNumber",hex:...}` blobs
// that the manager can't coerce back into uint256 args.
function normaliseArgs(args: unknown[]): unknown[] {
  return args.map(normaliseArg);
}

function normaliseArg(value: unknown): unknown {
  if (BigNumber.isBigNumber(value)) {
    return value.toHexString();
  }
  if (typeof value === "bigint") {
    return "0x" + value.toString(16);
  }
  if (Array.isArray(value)) {
    return value.map(normaliseArg);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normaliseArg(v)]));
  }
  return value;
}

function synthesiseReceipt(hash: string, from: string, to: string, lite: TransactionReceiptLite): TransactionReceipt {
  const logs: Log[] = lite.logs.map((l, idx) => ({
    transactionHash: hash,
    blockHash: lite.blockHash,
    blockNumber: lite.blockNumber,
    logIndex: idx,
    transactionIndex: 0,
    removed: false,
    address: l.address,
    topics: l.topics,
    data: l.data,
  }));
  const receipt = {
    transactionHash: hash,
    blockHash: lite.blockHash,
    blockNumber: lite.blockNumber,
    status: lite.status,
    gasUsed: BigNumber.from(lite.gasUsed),
    effectiveGasPrice: BigNumber.from(lite.effectiveGasPrice),
    logs,
    from,
    to,
    contractAddress: "",
    transactionIndex: 0,
    logsBloom: "0x",
    cumulativeGasUsed: BigNumber.from(0),
    confirmations: 1,
    byzantium: true,
    type: 0,
  };
  return receipt as unknown as TransactionReceipt;
}

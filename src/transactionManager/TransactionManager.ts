import assert from "assert";
import { typeguards } from "@across-protocol/sdk";
import { BigNumber, ethers } from "ethers";
import { Log, TransactionReceipt, TransactionResponse } from "@ethersproject/abstract-provider";
import { InstanceCoordinator, isDefined, scheduleSequentialTask, Signer, winston } from "../utils";
import { RedisPubSub } from "../messaging/redis/PubSub";
import { RedisCacheInterface } from "../cache/Redis";
import { AugmentedTransaction, TransactionClient } from "../clients/TransactionClient";
import {
  AckFailure,
  AckMessage,
  decodeRequest,
  encodeAck,
  encodeFinal,
  FinalMessage,
  SubmissionRequest,
  TransactionReceiptLite,
} from "./wire";

const CONFIRMATION_TIMEOUT_MS_DEFAULT = 180_000;
const LEASE_TTL_SEC_DEFAULT = 60;
const LEASE_RENEW_INTERVAL_SEC_DEFAULT = 20;

export interface TransactionManagerOptions {
  chainId: number;
  // EOA owned by this manager. Must be connected to a Provider for the chain.
  signer: Signer;
  // Per-process identifier; used as the InstanceCoordinator lease value.
  runIdentifier: string;
  // Redis forbids PUBLISH on a connection in SUBSCRIBE state; publisher and
  // subscriber must own distinct sockets.
  publisher: RedisPubSub;
  subscriber: RedisPubSub;
  // Backs the InstanceCoordinator that enforces one-active-manager-per-EOA.
  cache: RedisCacheInterface;
  logger: winston.Logger;
  // External cancellation; manager also aborts on lease loss.
  abortController: AbortController;
  // Total wall-clock budget per request for confirmation, in ms.
  confirmationTimeoutMs?: number;
  // Lease TTL and renewal cadence. TTL > renewal interval, with safety margin.
  leaseTtlSec?: number;
  leaseRenewIntervalSec?: number;
  // Optional dependency injection; defaults to a fresh direct-RPC client.
  txnClient?: TransactionClient;
}

// Topic construction.
export function requestTopic(chainId: number, eoa: string): string {
  return `txn:requests:${chainId}:${eoa.toLowerCase()}`;
}
export function responseTopic(chainId: number, eoa: string): string {
  return `txn:responses:${chainId}:${eoa.toLowerCase()}`;
}

// Standalone TransactionManager process. One instance owns one (chainId, EOA).
// Receives submission requests via Redis Pub/Sub, broadcasts to chain, emits
// ack + final responses on the per-EOA response topic. Phase 1 (broadcast)
// is serialised via a promise chain to preserve nonce ordering; phase 2
// (confirmation tracking) detaches so the next phase 1 can start.
export class TransactionManager {
  private responseTopic?: string;
  private readonly txnClient: TransactionClient;
  private readonly confirmationTimeoutMs: number;
  private readonly leaseTtlSec: number;
  private readonly leaseRenewIntervalSec: number;
  // Detached phase-2 tasks (confirmation tracking). Drained on shutdown.
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly opts: TransactionManagerOptions) {
    this.txnClient = opts.txnClient ?? new TransactionClient(opts.logger, [], "rpc");
    this.confirmationTimeoutMs = opts.confirmationTimeoutMs ?? CONFIRMATION_TIMEOUT_MS_DEFAULT;
    this.leaseTtlSec = opts.leaseTtlSec ?? LEASE_TTL_SEC_DEFAULT;
    this.leaseRenewIntervalSec = opts.leaseRenewIntervalSec ?? LEASE_RENEW_INTERVAL_SEC_DEFAULT;
  }

  async start(): Promise<void> {
    const eoa = (await this.opts.signer.getAddress()).toLowerCase();
    const reqTopic = requestTopic(this.opts.chainId, eoa);
    const respTopic = responseTopic(this.opts.chainId, eoa);
    this.responseTopic = respTopic;
    const { abortController } = this.opts;
    const { signal } = abortController;

    // Enforce one-active-manager-per-EOA. Aggressive handover: writing our
    // runIdentifier displaces any prior holder; the prior holder's next
    // renewal observes the change and aborts.
    const coord = new InstanceCoordinator(
      this.opts.logger,
      this.opts.cache,
      `across-transaction-manager-${eoa}`,
      this.opts.runIdentifier,
      abortController,
      this.leaseTtlSec
    );
    await coord.initiateHandover();
    scheduleSequentialTask(
      "TransactionManager lease renewal",
      this.opts.logger,
      () => this.renewLease(coord),
      this.leaseRenewIntervalSec,
      signal
    );

    this.opts.logger.info({
      at: "TransactionManager#start",
      message: "Starting transaction manager",
      chainId: this.opts.chainId,
      eoa,
      runIdentifier: this.opts.runIdentifier,
      requestTopic: reqTopic,
      responseTopic: respTopic,
    });

    // Phase 1 serialisation. Each incoming request appends itself onto the
    // chain so broadcasts run in arrival order and never compete for a nonce.
    let chain: Promise<unknown> = Promise.resolve();
    const listener = (payload: string, topic: string): void => {
      if (topic !== reqTopic) {
        return;
      }
      let req: SubmissionRequest;
      try {
        req = decodeRequest(payload);
      } catch (err) {
        this.opts.logger.warn({
          at: "TransactionManager#listener",
          message: "Decode failed; dropping",
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      // Always process: once the request is in the chain, the caller is
      // waiting for an ACK. Skipping on abort would leave the caller hanging.
      // After abort, listener is unsubbed so no new requests can enqueue.
      chain = chain
        .then(() => this.processRequest(req))
        .catch((err) =>
          this.opts.logger.error({
            at: "TransactionManager#processRequest",
            message: "Unhandled error",
            id: req.id,
            error: err instanceof Error ? err.stack : String(err),
          })
        );
    };

    await this.opts.subscriber.sub(reqTopic, listener);

    try {
      // Block until external signal aborts.
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    } finally {
      await this.opts.subscriber.unsub(reqTopic, listener);
      await chain; // drain pending phase 1
      await Promise.allSettled(this.inFlight); // drain pending phase 2
    }
  }

  private async renewLease(coord: InstanceCoordinator): Promise<void> {
    const active = await coord.getActiveInstance();
    if (active !== this.opts.runIdentifier) {
      this.opts.logger.warn({
        at: "TransactionManager#renewLease",
        message: `Lost lease for ${coord.identifier}; ${active ?? "<none>"} is now active. Draining.`,
      });
      this.opts.abortController.abort();
      return;
    }
    await coord.setActiveInstance();
  }

  private async processRequest(req: SubmissionRequest): Promise<void> {
    let response: TransactionResponse | undefined;
    try {
      response = await this.broadcastRequest(req);
    } catch (err) {
      this.opts.logger.error({
        at: "TransactionManager#processRequest",
        message: "Unhandled error in broadcast phase",
        id: req.id,
        error: err instanceof Error ? err.stack : String(err),
      });
      await this.emitAckFailure(req.id, "unknown", err instanceof Error ? err.message : String(err));
      return;
    }

    if (!isDefined(response)) {
      // Pre-broadcast failure; broadcastRequest already emitted an ack failure.
      return;
    }

    await this.emitAckSuccess(req.id, response.hash, response.nonce);

    // Detach phase 2 so the worker can pull the next request.
    const task = this.handleConfirmation(req, response);
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  // Phase 1: simulate + broadcast. Returns the response on success, undefined
  // on pre-broadcast failure (in which case an ack failure has been emitted).
  private async broadcastRequest(req: SubmissionRequest): Promise<TransactionResponse | undefined> {
    const augTxn = this.buildAugmentedTransaction(req);

    const [simResult] = await this.txnClient.simulate([augTxn]);
    if (!simResult.succeed) {
      this.opts.logger.warn({
        at: "TransactionManager#broadcastRequest",
        message: "Simulation failed",
        id: req.id,
        reason: simResult.reason,
      });
      await this.emitAckFailure(req.id, "simulation", simResult.reason ?? "simulation reverted");
      return undefined;
    }

    let response: TransactionResponse;
    try {
      const [r] = await this.txnClient.submit(req.chainId, [augTxn]);
      response = r;
    } catch (err) {
      const failure = classifyAckFailure(err);
      await this.emitAckFailure(req.id, failure.reason, failure.message);
      return undefined;
    }
    return response;
  }

  // Phase 2: await confirmation, emit final.
  private async handleConfirmation(req: SubmissionRequest, response: TransactionResponse): Promise<void> {
    try {
      await this.waitAndEmitFinal(req, response);
    } catch (err) {
      this.opts.logger.error({
        at: "TransactionManager#handleConfirmation",
        message: "Unhandled error in confirmation phase",
        id: req.id,
        error: err instanceof Error ? err.stack : String(err),
      });
    }
  }

  private async waitAndEmitFinal(req: SubmissionRequest, response: TransactionResponse): Promise<void> {
    const confirmations = req.confirmations ?? 1;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let receipt: TransactionReceipt;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Confirmation timeout after ${this.confirmationTimeoutMs}ms`)),
          this.confirmationTimeoutMs
        );
      });
      receipt = await Promise.race([response.wait(confirmations), timeout]);
    } catch (err) {
      await this.emitFinalFailure(
        req.id,
        "confirmation",
        err instanceof Error ? err.message : String(err),
        response.hash
      );
      return;
    } finally {
      if (isDefined(timeoutHandle)) {
        clearTimeout(timeoutHandle);
      }
    }

    if (receipt.status !== 1) {
      await this.emitFinalFailure(req.id, "reverted", "transaction status = 0", receipt.transactionHash);
      return;
    }
    await this.emitFinalSuccess(req.id, receipt);
  }

  private buildAugmentedTransaction(req: SubmissionRequest): AugmentedTransaction {
    const abi = parseAbi(req.abi);
    const contract = new ethers.Contract(req.to, abi, this.opts.signer);
    return {
      contract,
      chainId: req.chainId,
      method: req.method,
      args: req.args,
      gasLimit: isDefined(req.gasLimit) ? BigNumber.from(req.gasLimit) : undefined,
      gasLimitMultiplier: req.gasLimitMultiplier,
      value: isDefined(req.value) ? BigNumber.from(req.value) : undefined,
      message: req.message,
      mrkdwn: req.mrkdwn,
    };
  }

  private async emitAckSuccess(id: string, hash: string, nonce: number): Promise<void> {
    const msg: AckMessage = { id, phase: "ack", ok: true, hash, nonce };
    await this.publishResponse(encodeAck(msg));
  }

  private async emitAckFailure(id: string, reason: AckFailure, error: string): Promise<void> {
    const msg: AckMessage = { id, phase: "ack", ok: false, reason, error };
    await this.publishResponse(encodeAck(msg));
  }

  private async emitFinalSuccess(id: string, receipt: TransactionReceipt): Promise<void> {
    const msg: FinalMessage = {
      id,
      phase: "final",
      ok: true,
      hash: receipt.transactionHash,
      receipt: toReceiptLite(receipt),
    };
    await this.publishResponse(encodeFinal(msg));
  }

  private async emitFinalFailure(
    id: string,
    reason: "confirmation" | "reverted",
    error: string,
    hash?: string
  ): Promise<void> {
    const msg: FinalMessage = { id, phase: "final", ok: false, reason, error, hash };
    await this.publishResponse(encodeFinal(msg));
  }

  private async publishResponse(payload: string): Promise<void> {
    assert(isDefined(this.responseTopic), "TransactionManager.publishResponse called before start()");
    try {
      await this.opts.publisher.pub(this.responseTopic, payload);
    } catch (err) {
      this.opts.logger.warn({
        at: "TransactionManager#publishResponse",
        message: "Failed to publish response",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function parseAbi(abi: SubmissionRequest["abi"]): ethers.ContractInterface {
  if (typeof abi === "string") {
    return abi === "" ? [] : abi;
  }
  // ethers accepts a JSON-encoded ABI string. Stringifying avoids structural
  // assertions on the fragment shape — ethers parses + validates at construction.
  return JSON.stringify(abi);
}

function toReceiptLite(receipt: TransactionReceipt): TransactionReceiptLite {
  return {
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    status: receipt.status === 1 ? 1 : 0,
    gasUsed: receipt.gasUsed.toHexString(),
    effectiveGasPrice: receipt.effectiveGasPrice?.toHexString() ?? "0x0",
    logs: receipt.logs.map((l: Log) => ({
      address: l.address,
      topics: l.topics,
      data: l.data,
    })),
  };
}

export function classifyAckFailure(err: unknown): { reason: AckFailure; message: string } {
  if (typeguards.isEthersError(err)) {
    const { code, reason: errReason } = err;
    if (code === ethers.errors.INSUFFICIENT_FUNDS) {
      return { reason: "insufficient_funds", message: err.message };
    }
    if (
      code === ethers.errors.INVALID_ARGUMENT ||
      code === ethers.errors.MISSING_ARGUMENT ||
      code === ethers.errors.UNEXPECTED_ARGUMENT
    ) {
      return { reason: "validation", message: err.message };
    }
    if (code === ethers.errors.UNPREDICTABLE_GAS_LIMIT) {
      if ((errReason ?? "").includes("revert")) {
        return { reason: "simulation", message: err.message };
      }
    }
    // REPLACEMENT_UNDERPRICED is retried inside TransactionClient with scaled
    // gas; if it surfaces here, retries were exhausted — falls through to "unknown".
  }
  return { reason: "unknown", message: err instanceof Error ? err.message : String(err) };
}

import { utils as ethersUtils } from "ethers";
import { Provider, TransactionReceipt, winston } from "../utils";
import { BroadcastRevertedError, TransientDependencyError, UnresolvedBroadcastError } from "./errors";
import { HandlerResult } from "./handler";
import { BroadcastPendingState, TerminalState, TransferStore, classifyReceipt } from "./transferState";

/**
 * `MetadataEmitted(bytes)`, emitted by the AcrossEventEmitter when the execute carries `erc20Transfer`
 * provenance. Only the topic is needed: the check is "did the event we asked for land", not "which transfer
 * does it name", so there is no payload to decode and no emitter address to resolve. The service never
 * publishes `deposit_executed`; the indexer ingests this event instead.
 */
const METADATA_EMITTED_TOPIC = ethersUtils.id("MetadataEmitted(bytes)");

/**
 * TronWeb reports an un-prefixed `txid`, which `onBroadcast` records verbatim, but Tron's eth-JSON-RPC
 * provider needs the prefix. Storing verbatim and prefixing at lookup keeps the record identical to what the
 * chain's own tooling shows.
 */
export function receiptLookupHash(txHash: string): string {
  return txHash.startsWith("0x") ? txHash : `0x${txHash}`;
}

/**
 * Whether the receipt carries the provenance event the execute requested.
 *
 * A successful receipt without it is worth seeing — the indexer will not learn about this sweep on its own —
 * but it must **never** cause re-execution: the funds have already moved.
 */
export function hasMetadataEvent(receipt: TransactionReceipt): boolean {
  return (receipt.logs ?? []).some((log) => log.topics?.[0] === METADATA_EMITTED_TOPIC);
}

export interface ResolveDeps {
  logger: winston.Logger;
  store: TransferStore;
  provider: Provider;
}

/**
 * Resolves a `broadcast_pending` record against the chain, and is the **only** place a terminal state is
 * written for an execute.
 *
 * Called from two places with the same meaning: by a redelivery that found a pending record, and by the
 * fresh-execute path once its own transaction is on the wire. That is deliberate rather than convenient —
 * `submit()` catches `_submit`'s throw, deletes its nonce cache and returns an empty array, so
 * `submitTransaction` flattens revert, exhausted-`maxTries` and RPC failure into one untyped `Error`. There
 * is nothing in the exception to switch on, so the outcome comes from the chain in both cases.
 *
 * **Returns only when the transaction confirmed**, and throws a typed error otherwise. Unusual enough to
 * state, and deliberate: the retry decision then travels with the error instead of being re-derived from a
 * result by each caller.
 *
 * Three outcomes, and only one of them clears anything. A revert is the sole case where the record can be
 * removed, because a reverted transaction provably moved nothing.
 */
export async function resolvePendingTransaction(
  deps: ResolveDeps,
  transferId: string,
  pending: BroadcastPendingState
): Promise<HandlerResult> {
  const { logger, store, provider } = deps;
  const { txHash, chainId, operation } = pending;
  const fields = { transferId, txHash, chainId, operation };

  // Typed non-nullable by ethers, but null at runtime for an unmined hash — `classifyReceipt` guards that.
  let receipt: TransactionReceipt;
  try {
    receipt = await provider.getTransactionReceipt(receiptLookupHash(txHash));
  } catch (err) {
    // An RPC failure is not evidence of anything. Retain the record and let a later delivery look again.
    throw new TransientDependencyError(`failed to fetch receipt for ${txHash}: ${stringify(err)}`, err);
  }

  switch (classifyReceipt(receipt)) {
    case "confirmed": {
      // Has a blockNumber by construction: classifyReceipt only answers "confirmed" when one is present.
      const confirmed = receipt;
      const metadataEmitted = hasMetadataEvent(confirmed);
      if (!metadataEmitted) {
        logger.warn({
          at: "DepositAddressService#resolvePendingTransaction",
          message: "Execute confirmed without the expected provenance metadata event.",
          ...fields,
          blockNumber: confirmed.blockNumber,
        });
      }

      const terminal: TerminalState = {
        status: operation === "deposit" ? "deposit_executed" : "withdraw_executed",
        txHash,
        chainId,
        blockNumber: confirmed.blockNumber,
        completedAtMs: Date.now(),
      };
      await store.recordTerminal(transferId, terminal);
      return { outcome: terminal.status, fields: { ...fields, blockNumber: confirmed.blockNumber, metadataEmitted } };
    }

    case "reverted":
      // Nothing moved, so the transfer may be attempted again. Cleared under the lock, and only if the record
      // still names this transaction.
      await store.clearRevertedBroadcast(transferId, txHash);
      throw new BroadcastRevertedError(`transaction ${txHash} on chain ${chainId} reverted`);

    case "unresolved":
      // Every reason a receipt is missing gets the same answer, deliberately. It may be unmined, dropped,
      // replaced at its nonce, already mined behind a lagging RPC node, or reorged out — and the observable
      // evidence does not separate them. Retaining is safe in all five; clearing is unrecoverable in two of
      // them, because the funds may already have moved. So there is nothing to discriminate.
      //
      // Nonce management is `TransactionClient`'s concern, not this service's: its confirmation wait already
      // refuses to resubmit a consumed nonce, and re-notifies `onBroadcast` when it replaces a transaction, so
      // the record follows the live hash while a worker is alive. A worker that *dies* mid-confirm can still
      // leave a record naming a transaction that will never mine — that transfer stays blocked until an
      // operator clears the key. Accepted; see the issue's Scope.
      throw new UnresolvedBroadcastError(
        `transaction ${txHash} on chain ${chainId} has no receipt; retaining broadcast_pending`
      );
  }
}

function stringify(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

import { utils as ethersUtils } from "ethers";
import { Provider, TransactionReceipt, winston } from "../utils";
import { isDefined } from "../utils/TypeGuards";
import {
  BroadcastRevertedError,
  ReplacedBroadcastError,
  TransientDependencyError,
  UnresolvedBroadcastError,
} from "./errors";
import { HandlerResult } from "./handler";
import {
  BroadcastPendingState,
  TerminalState,
  TransferStore,
  classifyReceipt,
  replacementTarget,
} from "./transferState";

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

export interface ReconcileDeps {
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
 * Throws on every non-terminal outcome, so the retry decision travels with the error rather than being
 * re-derived by the caller.
 */
export async function reconcileBroadcast(
  deps: ReconcileDeps,
  transferId: string,
  pending: BroadcastPendingState
): Promise<HandlerResult> {
  const { logger, store, provider } = deps;
  const { txHash, chainId, operation } = pending;
  const fields = { transferId, txHash, chainId, operation, nonce: pending.nonce, signer: pending.from };

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
          at: "DepositAddressService#reconcileBroadcast",
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
      return await resolveMissingReceipt(deps, transferId, pending);
  }
}

/**
 * No receipt yet: either the transaction is still in flight, or it was replaced at its nonce and never will
 * be. Only the second is safe to clear, and only on EVM.
 *
 * The discriminator is `TransactionClient`'s own "a consumed nonce must not be resubmitted" check, inverted:
 * if some *other* transaction spent this nonce while ours still has no receipt, ours can never mine. It moved
 * nothing, so clearing cannot double-sweep — which is what keeps an accepted nonce collision from stranding a
 * transfer forever behind a no-TTL key.
 *
 * Absent that evidence the record is **retained**. Guessing "gone" here is the one irreversible direction.
 */
async function resolveMissingReceipt(
  deps: ReconcileDeps,
  transferId: string,
  pending: BroadcastPendingState
): Promise<never> {
  const { store, provider } = deps;
  const target = replacementTarget(pending);

  if (isDefined(target)) {
    let latestNonce: number;
    try {
      latestNonce = await provider.getTransactionCount(target.from, "latest");
    } catch (err) {
      // Cannot tell replaced from in-flight, so retain rather than guess.
      throw new TransientDependencyError(`failed to read nonce for ${target.from}: ${stringify(err)}`, err);
    }

    if (latestNonce > target.nonce) {
      await store.clearRevertedBroadcast(transferId, pending.txHash);
      throw new ReplacedBroadcastError(
        `transaction ${pending.txHash} was replaced at nonce ${target.nonce} (chain is at ${latestNonce})`
      );
    }
  }

  throw new UnresolvedBroadcastError(
    `transaction ${pending.txHash} on chain ${pending.chainId} has no receipt; retaining broadcast_pending`
  );
}

function stringify(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

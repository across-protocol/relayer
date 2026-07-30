import { create, number, object, string } from "superstruct";

/**
 * A deposit execute that has been broadcast but whose outcome this process never observed. Written
 * before the confirmation wait, so an evicted process doesn't lose track of a transfer already on
 * the wire. See the module README's "In-flight execute claims" section for the full rationale.
 */
export type PendingExecute = {
  /** Hash of the broadcast execute transaction; the key used to resolve the outcome on a later run. */
  txHash: string;
  /** Chain the execute was submitted to (also the funding transfer's chain). */
  chainId: number;
  /** `erc20Transfer.transactionHash` — the dedup key for the executed-deposits set. */
  refTxHash: string;
  /** Unix seconds at broadcast; used to expire records whose transaction never appeared on-chain. */
  submittedAt: number;
};

const PendingExecuteStruct = object({
  txHash: string(),
  chainId: number(),
  refTxHash: string(),
  submittedAt: number(),
});

/**
 * Parse one persisted claim (a single Redis hash field). Throws on a malformed payload.
 *
 * Claims are stored per-field rather than as one serialized map so that two processes recording
 * different transfers cannot drop each other's claim — see the module README.
 */
export function parsePendingExecute(json: string): PendingExecute {
  return create(JSON.parse(json), PendingExecuteStruct);
}

/**
 * Age after which a pending record with no on-chain receipt is discarded so the deposit can be
 * re-attempted — safe on EVM because a resubmit reuses the nonce and replaces the original. Not
 * safe on nonce-less chains, where those claims are retained instead (see `_settlePendingExecute`).
 */
export const PENDING_EXECUTE_STALE_SECONDS = 900;

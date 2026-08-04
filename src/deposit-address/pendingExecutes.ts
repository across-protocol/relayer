import { create, number, object, string } from "superstruct";

/**
 * A deposit execute that has been broadcast but whose outcome this process never observed. Written
 * before the confirmation wait, so a process evicted at handover doesn't lose track of a transfer
 * already on the wire. See the module README's "In-flight execute claims" section.
 */
export type PendingExecute = {
  /** Hash of the broadcast execute; the key used to resolve its outcome on-chain later. */
  txHash: string;
  /** Chain the execute was submitted to (also the funding transfer's chain). */
  chainId: number;
  /** `erc20Transfer.transactionHash` — the dedup key for the executed-deposits set. */
  refTxHash: string;
  /** Unix seconds at broadcast. Purely diagnostic: no logic expires a claim. */
  submittedAt: number;
};

const PendingExecuteStruct = object({
  txHash: string(),
  chainId: number(),
  refTxHash: string(),
  submittedAt: number(),
});

/** Parse one persisted claim (a single Redis hash field). Throws on a malformed payload. */
export function parsePendingExecute(json: string): PendingExecute {
  return create(JSON.parse(json), PendingExecuteStruct);
}

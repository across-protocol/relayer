import { create, number, object, record, string } from "superstruct";

/**
 * A deposit execute that has been broadcast but whose outcome this process never observed.
 *
 * The record is written at broadcast time — before the confirmation wait — so that a process which
 * is evicted mid-confirmation (the handler is handed over on a fixed cadence, so this is routine)
 * does not lose the fact that a transaction is already in flight. Without it, the successor sees no
 * dedup entry and the only thing standing between it and a duplicate execute is the deposit
 * address's balance, which is unsound: the address is a shared pot, so an unrelated inbound
 * transfer can make an already-executed message look executable again.
 *
 * The `erc20Transfer` projection is carried so that a successor which adopts the execute can
 * rebuild the `deposit_executed` lifecycle payload without needing the original indexer message
 * (the indexer may have stopped serving it by then).
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
  depositAddress: string;
  /** `erc20Transfer.contractAddress`, needed to locate the settlement log in the receipt. */
  token: string;
  /** `erc20Transfer.blockNumber` / `logIndex` of the inbound funding transfer. */
  blockNumber: number;
  logIndex: number;
};

const PendingExecuteStruct = object({
  txHash: string(),
  chainId: number(),
  refTxHash: string(),
  submittedAt: number(),
  depositAddress: string(),
  token: string(),
  blockNumber: number(),
  logIndex: number(),
});

const PendingExecutesStruct = record(string(), PendingExecuteStruct);

/** Parse the persisted `depositKey -> PendingExecute` map. Throws on a malformed payload. */
export function parsePendingExecutes(json = "{}"): Record<string, PendingExecute> {
  return create(JSON.parse(json), PendingExecutesStruct);
}

/**
 * Age after which a pending record whose transaction has still not appeared on-chain is discarded
 * and the deposit is allowed to be re-attempted. A resubmit derives its nonce from
 * `getTransactionCount("latest")`, so it reuses the stranded transaction's nonce and replaces it
 * rather than duplicating it — which is what makes discarding safe once the original is clearly
 * never going to land.
 */
export const PENDING_EXECUTE_STALE_SECONDS = 900;

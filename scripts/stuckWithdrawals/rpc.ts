/**
 * RPC primitives.
 *
 * Everything here exists because of a specific way this investigation went wrong.
 * Read the comments before "simplifying" any of it.
 */
import { ethers } from "ethers";

export type Log = ethers.providers.Log;

export interface ChunkStats {
  okChunks: number;
  failChunks: number;
  events: number;
  fromBlock: number;
  toBlock: number;
  /** Ranges we could not read after exhausting retries. Non-empty => the scan is NOT exhaustive. */
  gaps: Array<[number, number]>;
}

export class RpcError extends Error {}

export function provider(url: string): ethers.providers.JsonRpcProvider {
  // Several public endpoints (Mode, Zora, Unichain) reject requests without a browser UA.
  return new ethers.providers.JsonRpcProvider({ url, headers: { "User-Agent": "Mozilla/5.0" } });
}

export function resolveRpc(envNames: string[]): string | undefined {
  for (const n of envNames) {
    const v = process.env[n];
    if (v && v.length > 0) return v;
  }
  return undefined;
}

/**
 * eth_getLogs with adaptive chunking.
 *
 * TRAP THIS GUARDS AGAINST: these endpoints return `{"error":{...}}` or time out on wide
 * ranges, and a naive caller that reads `result?.length ?? 0` sees a timeout as "zero events".
 * That produced false "nothing pending" answers three separate times during the manual
 * investigation. So: every failure is either retried at finer granularity or recorded as a
 * gap. A caller that ignores `gaps` is not entitled to claim exhaustiveness.
 */
export async function getLogsChunked(
  p: ethers.providers.JsonRpcProvider,
  filter: { address?: string | string[]; topics?: (string | string[] | null)[] },
  fromBlock: number,
  toBlock: number,
  opts: { chunk?: number; minChunk?: number; retries?: number; onBatch?: (logs: Log[]) => void } = {}
): Promise<{ logs: Log[]; stats: ChunkStats }> {
  const chunk0 = opts.chunk ?? 20_000;
  const minChunk = opts.minChunk ?? 200;
  const retries = opts.retries ?? 4;

  const logs: Log[] = [];
  const stats: ChunkStats = { okChunks: 0, failChunks: 0, events: 0, fromBlock, toBlock, gaps: [] };

  let start = fromBlock;
  let size = chunk0;
  /** Successful batches at the current `size`. Growing before this is >0 livelocks — see below. */
  let okAtSize = 0;

  while (start <= toBlock) {
    const end = Math.min(start + size - 1, toBlock);
    let succeeded = false;
    let shrank = false;
    let attempt = 0;

    while (attempt < retries) {
      try {
        const batch = await p.send("eth_getLogs", [{ ...filter, fromBlock: hex(start), toBlock: hex(end) }]);
        if (!Array.isArray(batch)) throw new RpcError(`non-array result: ${JSON.stringify(batch).slice(0, 120)}`);
        stats.okChunks++;
        stats.events += batch.length;
        logs.push(...batch);
        opts.onBatch?.(batch);
        succeeded = true;
        break;
      } catch (err) {
        attempt++;
        // Shrink and retry the SAME `start`. Range-too-wide and timeout both present as
        // opaque errors, so we cannot tell them apart and simply narrow the request.
        if (size > minChunk) {
          size = Math.max(minChunk, Math.floor(size / 4));
          shrank = true;
          break; // recompute `end` with the smaller size
        }
        if (attempt < retries) await sleep(400 * attempt);
      }
    }

    if (succeeded) {
      start = end + 1;
      okAtSize++;
      /**
       * Grow ONLY after the current size has actually delivered. The previous version grew
       * whenever `failChunks === 0`, which included the iteration that had just shrunk — so an
       * endpoint that rejects `chunk0` but accepts `chunk0/4` livelocked: shrink, grow, reject,
       * shrink, grow, ... forever, never issuing the smaller request and never recording a gap.
       */
      if (okAtSize >= 2 && size < chunk0) {
        size = Math.min(chunk0, size * 2);
        okAtSize = 0;
      }
    } else if (shrank) {
      okAtSize = 0; // retry [start, start+size-1] with the narrower window
    } else {
      // Exhausted retries at minChunk. Record the gap and move on; the caller is not entitled
      // to claim exhaustiveness while stats.gaps is non-empty.
      stats.failChunks++;
      stats.gaps.push([start, end]);
      start = end + 1;
      okAtSize = 0;
    }
  }
  return { logs, stats };
}

/** Binary search for the first block with timestamp >= target. Verifies the boundary. */
export async function blockForTimestamp(
  p: ethers.providers.JsonRpcProvider,
  targetTs: number
): Promise<{ block: number; ts: number; prevTs: number }> {
  let lo = 1;
  let hi = await p.getBlockNumber();
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await p.getBlock(mid);
    if (!b) {
      lo = mid + 1;
      continue;
    }
    if (b.timestamp < targetTs) lo = mid + 1;
    else hi = mid;
  }
  const ts = (await p.getBlock(lo)).timestamp;
  const prevTs = lo > 1 ? (await p.getBlock(lo - 1)).timestamp : 0;
  return { block: lo, ts, prevTs };
}

export async function blockTimestamp(p: ethers.providers.JsonRpcProvider, block: number): Promise<number> {
  return (await p.getBlock(block)).timestamp;
}

/**
 * Substring-match a set of addresses against a log's full payload (data + topics).
 *
 * WHY NOT decode properly: the initiator/recipient of a token withdrawal is buried inside a
 * nested cross-domain message whose inner selector varies by bridge (standard bridge,
 * bridged-USDC, Maker's DAI bridge, Synthetix, ...). Matching the raw payload is bridge-agnostic
 * and cannot be defeated by an unknown bridge. Decoding is done afterwards, best-effort, for
 * reporting only.
 */
export function payloadMatches(log: Log, needles: string[]): string[] {
  const blob = (log.data + log.topics.join("")).toLowerCase();
  return needles.filter((n) => blob.includes(n.toLowerCase().replace(/^0x/, "")));
}

export const hex = (n: number): string => "0x" + n.toString(16);
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * True when a failed eth_call is the node telling us the call REVERTED, i.e. a real answer about
 * chain state, as opposed to the node failing to answer at all.
 *
 * The distinction is load-bearing: see ethCall().
 */
function isRevert(err: unknown): boolean {
  const e = err as { code?: unknown; body?: string; error?: { code?: number; message?: string }; message?: string };
  // JSON-RPC error code 3 is "execution error"; ethers surfaces the inner error under `.error`.
  if (e?.error?.code === 3) return true;
  const msg = `${e?.error?.message ?? ""} ${e?.message ?? ""} ${e?.body ?? ""}`.toLowerCase();
  return (
    msg.includes("execution reverted") ||
    msg.includes("execution error") ||
    msg.includes("invalid opcode") ||
    msg.includes("out of gas")
  );
}

/**
 * eth_call returning raw hex.
 *
 * Returns `undefined` ONLY for a genuine revert — a real "no" from the node, which for these
 * oracles legitimately means "this function does not exist here" (see orbitClassicEntryExists).
 *
 * THROWS RpcError when the node could not answer (timeout, 429, 5xx, connection reset), after
 * retrying. This is the important half: the previous version swallowed every failure into
 * `undefined`, which isTrue() then read as `false`, which the scanner reported as STUCK. A
 * five-second L1 blip was therefore indistinguishable from an unclaimed withdrawal, and would
 * have produced exactly the class of false positive the controls exist to prevent. Callers must
 * let this propagate and record the candidate as `unknown`, never as a finding.
 */
export async function ethCall(
  p: ethers.providers.JsonRpcProvider,
  to: string,
  data: string,
  opts: { from?: string; retries?: number; block?: string } = {}
): Promise<string | undefined> {
  const retries = opts.retries ?? 3;
  let last: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await p.send("eth_call", [
        { to, data, ...(opts.from ? { from: opts.from } : {}) },
        opts.block ?? "latest",
      ]);
    } catch (err) {
      if (isRevert(err)) return undefined;
      last = err;
      if (attempt < retries) await sleep(300 * attempt);
    }
  }
  throw new RpcError(
    `eth_call ${to} ${data.slice(0, 10)} did not answer after ${retries} attempts: ${String(last).slice(0, 160)}`
  );
}

export const isTrue = (ret: string | undefined): boolean => ret !== undefined && ret.length >= 3 && BigInt(ret) === 1n;

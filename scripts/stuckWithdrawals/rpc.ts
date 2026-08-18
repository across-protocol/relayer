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

  while (start <= toBlock) {
    const end = Math.min(start + size - 1, toBlock);
    let ok = false;
    let attempt = 0;

    while (attempt < retries && !ok) {
      try {
        const batch = await p.send("eth_getLogs", [
          { ...filter, fromBlock: hex(start), toBlock: hex(end) },
        ]);
        if (!Array.isArray(batch)) throw new RpcError(`non-array result: ${JSON.stringify(batch).slice(0, 120)}`);
        stats.okChunks++;
        stats.events += batch.length;
        logs.push(...batch);
        opts.onBatch?.(batch);
        ok = true;
      } catch (err) {
        attempt++;
        // Shrink and retry. Range-too-wide and timeout both present as opaque errors.
        if (size > minChunk) {
          size = Math.max(minChunk, Math.floor(size / 4));
          break; // recompute `end` with the smaller size
        }
        if (attempt >= retries) {
          stats.failChunks++;
          stats.gaps.push([start, end]);
          ok = true; // give up on this range, but it is recorded as a gap
        } else {
          await sleep(400 * attempt);
        }
      }
    }
    if (ok) {
      // Only advance if we actually consumed [start,end]; a shrink leaves start untouched.
      const consumed = Math.min(start + size - 1, toBlock);
      if (consumed >= end) start = end + 1;
    }
    // Gently grow back toward the configured chunk size after a successful run.
    if (stats.failChunks === 0 && size < chunk0) size = Math.min(chunk0, size * 2);
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

/** eth_call returning raw hex, or undefined on revert. Never throws for reverts. */
export async function ethCall(
  p: ethers.providers.JsonRpcProvider,
  to: string,
  data: string,
  from?: string
): Promise<string | undefined> {
  try {
    return await p.send("eth_call", [{ to, data, ...(from ? { from } : {}) }, "latest"]);
  } catch {
    return undefined;
  }
}

export const isTrue = (ret: string | undefined): boolean =>
  ret !== undefined && ret.length >= 3 && BigInt(ret) === 1n;

/**
 * Offline self-tests for the RPC plumbing. No network, no RPC env, runs in milliseconds as part of
 * `--verify-fixtures`.
 *
 * These cover the failure modes that produce a WRONG ANSWER rather than an error, which the
 * on-chain fixtures cannot see: the fixtures all resolve single keys through healthy endpoints, so
 * a scanner that silently skips block ranges — or never terminates — passes every one of them.
 */
import { getLogsChunked } from "./rpc";

/** Endpoint that rejects any range wider than `limit`, i.e. a public node with a getLogs cap. */
function cappedProvider(limit: number, opts: { alwaysFail?: boolean; budget?: number } = {}) {
  let calls = 0;
  const budget = opts.budget ?? 5000;
  return {
    calls: () => calls,
    async send(_method: string, params: [{ fromBlock: string; toBlock: string }]): Promise<unknown[]> {
      if (++calls > budget) {
        // Escapes the caller's try/catch by design — a livelock must fail the test, not be retried.
        process.stderr.write(`\nLIVELOCK: getLogsChunked issued >${budget} requests\n`);
        process.exit(1);
      }
      const { fromBlock, toBlock } = params[0];
      const width = parseInt(toBlock, 16) - parseInt(fromBlock, 16) + 1;
      if (opts.alwaysFail || width > limit) throw new Error(`range too wide: ${width} > ${limit}`);
      return [];
    },
  };
}

type Result = { label: string; ok: boolean; detail: string };

export async function selfTestChunking(): Promise<Result[]> {
  const out: Result[] = [];
  const p = (x: unknown) => x as unknown as Parameters<typeof getLogsChunked>[0];

  /**
   * REGRESSION: the shrink-then-immediately-grow livelock.
   *
   * getLogsChunked used to grow the window whenever `failChunks === 0`, which included the very
   * iteration that had just shrunk. Against an endpoint that rejects `chunk` but accepts `chunk/4`
   * it therefore oscillated forever — shrink to minChunk, grow back, get rejected, shrink again —
   * never issuing the narrower request and never recording a gap. The scan simply hung. Growing
   * only after a *successful* batch at the current size is what fixes it.
   */
  {
    const prov = cappedProvider(300);
    const { stats } = await getLogsChunked(p(prov), {}, 1, 5000, { chunk: 400, minChunk: 200 });
    out.push({
      label: "chunking: shrinks past an endpoint range cap without livelocking",
      ok: stats.gaps.length === 0 && stats.okChunks > 0,
      detail: `ok=${stats.okChunks} gaps=${stats.gaps.length} requests=${prov.calls()}`,
    });
  }

  // Same shape at the real default chunk size.
  {
    const prov = cappedProvider(1000);
    const { stats } = await getLogsChunked(p(prov), {}, 1, 20_000, { chunk: 20_000, minChunk: 200 });
    out.push({
      label: "chunking: covers the full range against a narrow cap",
      ok: stats.gaps.length === 0 && stats.okChunks > 0,
      detail: `ok=${stats.okChunks} gaps=${stats.gaps.length} requests=${prov.calls()}`,
    });
  }

  /**
   * An endpoint that never answers must terminate AND account for every block it could not read.
   * A silently dropped range is the difference between "nothing pending" and "we did not look".
   */
  {
    const prov = cappedProvider(0, { alwaysFail: true });
    const { stats } = await getLogsChunked(p(prov), {}, 1, 1000, { chunk: 400, minChunk: 200, retries: 2 });
    const covered = stats.gaps.reduce((n, [a, b]) => n + (b - a + 1), 0);
    out.push({
      label: "chunking: unreadable ranges are recorded as gaps, never skipped",
      ok: stats.gaps.length > 0 && covered === 1000,
      detail: `gaps=${stats.gaps.length} blocksAccountedFor=${covered}/1000`,
    });
  }

  return out;
}

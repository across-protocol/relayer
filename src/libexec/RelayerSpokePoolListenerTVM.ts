import assert from "assert";
import minimist from "minimist";
import { Contract } from "ethers";
import { Log } from "../interfaces";
import {
  delay,
  getBlockForTimestamp,
  getChainQuorum,
  getDeploymentBlockNumber,
  getNetworkName,
  getProvider,
  isDefined,
  Logger,
  paginatedEventQuery,
  Provider,
  SpokePool,
  winston,
} from "../utils";
import { getRedisCache } from "../cache/Redis";
import { bootstrap } from "./util/bootstrap";
import { postBlock, postEvents, removeEvent } from "./util/ipc";

const PROGRAM = "RelayerSpokePoolListenerTVM";
// Re-org reconcile window: re-scan this many trailing blocks each pass and diff against posted events.
export const REORG_WINDOW = 128;
// Seconds between head polls. Tuned just under TRON's ~3s block time: each new head is picked up
// within an interval without polling several times per block. A no-new-block poll is just one
// getBlock("latest"); any block missed by timing is covered by the next pass's range scan.
const POLL_INTERVAL_S = 2;
const abortController = new AbortController();

let spokePool: Contract;
let logger: winston.Logger;
let chainId: number;
let chain: string;

/**
 * Diff a freshly-scraped re-org window against previously-posted events. Events still present are
 * left as-is, newly-seen events are returned as additions, and posted events within the window that
 * have vanished (re-orged out) are returned as removals. `posted` is updated in place and pruned of
 * events that have aged below the window (final, not re-orged). Exported for unit testing.
 */
export function reconcileWindow(
  current: Log[],
  posted: Map<string, Log>,
  windowStart: number
): { additions: Log[]; removals: Log[] } {
  const key = (event: Log): string => `${event.event}-${event.blockHash}-${event.transactionHash}-${event.logIndex}`;
  const currentKeys = new Set(current.map(key));

  const removals: Log[] = [];
  for (const [eventKey, event] of posted) {
    if (event.blockNumber >= windowStart && !currentKeys.has(eventKey)) {
      removals.push(event);
      posted.delete(eventKey);
    }
  }

  const additions = current.filter((event) => !posted.has(key(event)));
  additions.forEach((event) => posted.set(key(event), event));

  // Drop events that have aged below the window: they are final, not re-orged.
  for (const [eventKey, event] of posted) {
    if (event.blockNumber < windowStart) {
      posted.delete(eventKey);
    }
  }

  return { additions, removals };
}

type ListenOpts = {
  liveEvents: string[];
  historicalEvents: string[];
  provider: Provider;
  startBlock: number;
  maxBlockRange: number;
};

/**
 * Index SpokePool events off a single quorum RetryProvider, which imposes node quorum on every
 * eth_getLogs. Backfill the look-back-only events once, then loop: advance over new blocks and
 * re-scan the trailing re-org window each pass, reconciling it against the events already posted.
 */
async function listen({
  liveEvents,
  historicalEvents,
  provider,
  startBlock,
  maxBlockRange,
}: ListenOpts): Promise<void> {
  const at = `${PROGRAM}::listen`;
  const contract = spokePool.connect(provider);

  const getEvents = async (eventNames: string[], fromBlock: number, toBlock: number): Promise<Log[]> => {
    if (eventNames.length === 0 || toBlock < fromBlock) {
      return [];
    }
    const searchConfig = { from: fromBlock, to: toBlock, maxLookBack: maxBlockRange };
    // Let failures propagate: the caller skips the pass rather than treating a failed query as "no
    // events", which would make reconcileWindow falsely retract recent events of that type.
    const results = await Promise.all(
      eventNames.map((name) => paginatedEventQuery(contract, contract.filters[name](), searchConfig))
    );
    return results.flat();
  };

  // Look-back-only events (root bundles, refund roots, speed-ups): scraped once up to the current
  // head and never tracked live.
  const { number: startHead } = await provider.getBlock("latest");
  try {
    const historical = await getEvents(historicalEvents, startBlock, startHead);
    if (historical.length > 0 && !postEvents(historical)) {
      abortController.abort();
      return;
    }
  } catch (error) {
    logger.warn({ at, message: `Failed to scrape ${chain} historical events.`, error: `${error}` });
    abortController.abort();
    return;
  }

  // Live events: advance over new blocks and re-scan the trailing re-org window, reconciling against
  // what we've posted (vanished → removeEvent, new or re-org-replaced → postEvents).
  const posted = new Map<string, Log>();
  let scannedThrough = startBlock - 1;

  while (!abortController.signal.aborted) {
    let head: number;
    let currentTime: number;
    try {
      ({ number: head, timestamp: currentTime } = await provider.getBlock("latest"));
    } catch (error) {
      logger.warn({ at, message: `Caught ${chain} getBlock error.`, error: `${error}` });
      await delay(POLL_INTERVAL_S);
      continue;
    }

    if (head <= scannedThrough) {
      await delay(POLL_INTERVAL_S);
      continue;
    }

    const windowStart = Math.max(startBlock, head - REORG_WINDOW + 1);

    try {
      // Fetch both ranges before committing: a query failure then skips the whole pass (retried next
      // tick) rather than reconciling against a partial view and retracting valid events. The backfill
      // is strictly below the re-org window (initial catch-up / large head jumps) — final, never
      // reconciled.
      const backfill = await getEvents(liveEvents, scannedThrough + 1, windowStart - 1);
      const current = await getEvents(liveEvents, windowStart, head);

      if (backfill.length > 0 && !postEvents(backfill)) {
        abortController.abort();
        break;
      }

      const { additions, removals } = reconcileWindow(current, posted, windowStart);
      let ok = true;
      for (const event of removals) {
        ok &&= removeEvent({ ...event, removed: true });
      }
      if (ok && additions.length > 0) {
        ok = postEvents(additions);
      }
      if (ok) {
        scannedThrough = head;
        ok = postBlock(head, currentTime);
      }
      if (!ok) {
        abortController.abort();
        break;
      }
    } catch (error) {
      logger.warn({ at, message: `Caught ${chain} getLogs error; skipping reconciliation pass.`, error: `${error}` });
    }

    await delay(POLL_INTERVAL_S);
  }
}

/**
 * Main entry point.
 */
async function run(argv: string[]): Promise<void> {
  const at = `${PROGRAM}::run`;

  const minimistOpts = {
    string: ["lookback", "spokepool"],
  };
  const args = minimist(argv, minimistOpts);

  ({ chainid: chainId } = args);
  const { lookback, blockrange: maxBlockRange = 10_000 } = args;
  assert(Number.isInteger(chainId), "chainId must be numeric ");
  assert(Number.isInteger(maxBlockRange), "maxBlockRange must be numeric");

  const { quorum = getChainQuorum(chainId) } = args;
  assert(Number.isInteger(quorum), "quorum must be numeric ");

  const { spokepool: spokePoolAddr } = args;
  // TVM chains (TRON) don't appear in the EVM deployment registry, so require the caller
  // to pass the SpokePool address explicitly rather than falling back to `getDeployedAddress`.
  assert(isDefined(spokePoolAddr), "TVM listener requires --spokepool=<address>");

  chain = getNetworkName(chainId);

  // useCache=false: don't cache this --quorum-overridden provider under the shared per-chain key.
  const quorumProvider = await getProvider(chainId, logger, false, quorum);
  const blockFinder: undefined = undefined;
  const cache = await getRedisCache();
  const latestBlock = await quorumProvider.getBlock("latest");

  // Deployment-block registry also lacks TVM entries; default to 0 so the lookback window stays bounded.
  let deploymentBlock = 0;
  try {
    deploymentBlock = getDeploymentBlockNumber("SpokePool", chainId);
  } catch {
    logger.debug({ at, message: `No deployment block registered for ${chain}; defaulting to 0.` });
  }

  let startBlock = latestBlock.number;
  if (/^@[0-9]+$/.test(lookback)) {
    startBlock = Number(lookback.slice(1));
  } else if (isDefined(lookback)) {
    assert(Number.isInteger(Number(lookback)), `Invalid lookback (${lookback})`);
    startBlock = Math.max(
      deploymentBlock,
      await getBlockForTimestamp(logger, chainId, latestBlock.timestamp - lookback, blockFinder, cache)
    );
  } else {
    logger.debug({ at, message: `Skipping lookback on ${chain}.` });
  }

  spokePool = new Contract(spokePoolAddr, SpokePool.abi);

  logger.debug({
    at,
    message: `Starting ${chain} SpokePool indexer.`,
    opts: { spokePool: spokePoolAddr, deploymentBlock, startBlock, maxBlockRange, quorum },
  });

  await listen({
    liveEvents: ["FundsDeposited", "FilledRelay"],
    historicalEvents: ["RequestedSpeedUpDeposit", "RelayedRootBundle", "ExecutedRelayerRefundRoot"],
    provider: quorumProvider,
    startBlock,
    maxBlockRange,
  });
}

if (require.main === module) {
  logger = Logger;
  bootstrap({ program: PROGRAM, abortController, chainName: () => chain, run });
}

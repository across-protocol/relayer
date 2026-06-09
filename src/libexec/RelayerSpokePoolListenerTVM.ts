import assert from "assert";
import minimist from "minimist";
import { Contract, utils as ethersUtils } from "ethers";
import { AbiEvent, BaseError, Block, createPublicClient, http, parseAbiItem } from "viem";
import { Log } from "../interfaces";
import {
  EventManager,
  isDefined,
  getBlockForTimestamp,
  getChainQuorum,
  getDeploymentBlockNumber,
  getNetworkName,
  getNodeUrlList,
  getOriginFromURL,
  getProvider,
  getProviderHeaders,
  getViemChain,
  Logger,
  Provider,
  retry,
  SpokePool,
  winston,
} from "../utils";
import { getRedisCache } from "../cache/Redis";
import { ScraperOpts } from "./types";
import { bootstrap, waitForAbort } from "./util/bootstrap";
import { postBlock, postEvents, removeEvent } from "./util/ipc";
import { scrapeEvents as _scrapeEvents } from "./util/evm";

const PROGRAM = "RelayerSpokePoolListenerTVM";
export const REORG_WINDOW = 128n;
// Re-poll this many blocks back from each announced head, so a getLogs that failed (or a provider
// briefly lagging behind its own announced block) is retried on subsequent blocks before its quorum
// vote is lost. EventManager dedupes the overlap.
const LOG_RETRY_DEPTH = 16n;
const abortController = new AbortController();

let spokePool: Contract;
let logger: winston.Logger;
let chainId: number;
let chain: string;

/**
 * Process one head-block arrival with parent-hash-based re-org detection. Any
 * events in `eventMgr` whose blockNumber is above the resolved fork point are
 * removed in place and returned, so the caller can IPC-notify the parent. This
 * function is exported so it can be driven directly from unit tests without
 * standing up a real viem provider.
 */
export function processBlock(
  block: Block,
  blocks: Map<bigint, string>,
  eventMgr: EventManager,
  chain: string,
  provider: string,
  logger: winston.Logger,
  reorgWindow = REORG_WINDOW
): { orphans: Log[]; accepted: boolean } {
  if (!block || block.hash === null || block.number === null) {
    logger.debug({
      at: `${PROGRAM}::processBlock`,
      message: `Received empty ${chain} block from ${provider}.`,
    });
    return { orphans: [], accepted: false };
  }

  const orphans: Log[] = [];
  const expectedParentHash = blocks.get(block.number - 1n);
  if (expectedParentHash !== undefined && expectedParentHash !== block.parentHash) {
    let forkedBlock: number | undefined;
    for (const [num, hash] of blocks) {
      if (hash === block.parentHash) {
        forkedBlock = Number(num);
        break;
      }
    }

    const deep = forkedBlock === undefined;
    forkedBlock ??= Math.min(...[...blocks.keys()].map(Number)) - 1;
    const message = deep
      ? `${chain} deep re-org at block ${block.number}; purging all tracked events above block ${forkedBlock}.`
      : `${chain} re-org detected at block ${block.number}; resuming from block ${forkedBlock}.`;
    logger.warn({ at: `${PROGRAM}::processBlock`, message, provider });

    const orphanBlockHashes = new Set<string>();
    for (const [hash, event] of Object.entries(eventMgr.events)) {
      if (event.blockNumber > forkedBlock) {
        orphans.push(event);
        orphanBlockHashes.add(event.blockHash);
        delete eventMgr.events[hash];
      }
    }
    for (const blockHash of orphanBlockHashes) {
      delete eventMgr.blockHashes[blockHash];
    }
    for (const num of [...blocks.keys()].filter((n) => Number(n) > forkedBlock)) {
      blocks.delete(num);
    }
  }

  blocks.set(block.number, block.hash);

  const pruneThreshold = block.number - reorgWindow;
  for (const num of [...blocks.keys()]) {
    if (num < pruneThreshold) {
      blocks.delete(num);
    }
  }

  return { orphans, accepted: true };
}

// TVM chains (TRON) use HTTPS unconditionally — wss is not reliably supported by public
// Tron JSON-RPC endpoints, and viem's `watchBlocks` degrades to polling under http, which
// is the right behaviour here.
function resolveProviders(chainId: number, quorum = 1) {
  const providerUrls = getNodeUrlList(chainId, quorum, "https");
  const nProviders = Object.keys(providerUrls).length;
  assert(nProviders >= quorum, `Insufficient providers for ${chain} (minimum ${quorum} required by quorum)`);

  const viemChain = getViemChain(chainId);
  return Object.entries(providerUrls).map(([provider, url]) => {
    const headers = getProviderHeaders(provider, chainId);
    return createPublicClient({
      chain: viemChain,
      transport: http(url, { fetchOptions: { headers } }),
      name: getOriginFromURL(url),
    });
  });
}

/**
 * Aggregate utils/scrapeEvents for a series of event names.
 */
async function scrapeEvents(
  address: string,
  eventSignatures: string[],
  provider: Provider,
  opts: ScraperOpts
): Promise<void> {
  const at = `${PROGRAM}::scrapeEvents`;
  const { number: toBlock, timestamp: currentTime } = await provider.getBlock("latest");

  const events = (
    await Promise.all(
      eventSignatures.map(async (sig) => {
        try {
          return await _scrapeEvents(provider, address, sig, { ...opts, toBlock }, logger);
        } catch {
          logger.warn({ at, message: `Failed to scrape ${chain} events.`, event: sig });
          return Promise.resolve([]);
        }
      })
    )
  ).flat();

  if (!abortController.signal.aborted) {
    let stop = !postBlock(toBlock, currentTime);
    if (events.length > 0) {
      stop ||= !postEvents(events);
    }
    if (stop) {
      abortController.abort();
    }
  }
}

/**
 * Drive `processBlock` for each head from the primary provider and fan the event
 * stream through EventManager across all providers. EventManager stays on its
 * master API; orphan removal is handled by `processBlock`.
 *
 * TRON JSON-RPC providers expire filter ids aggressively, so viem's `watchEvent`
 * (which polls via `eth_newFilter` + `eth_getFilterChanges`) fails with
 * "filter not found". Poll `eth_getLogs` per accepted block instead.
 */
async function listen(
  eventMgr: EventManager,
  spokePoolAddr: string,
  eventSignatures: string[],
  quorum: number
): Promise<void> {
  const at = `${PROGRAM}::listen`;
  const providers = resolveProviders(chainId, quorum);
  const blocks = new Map<bigint, string>();
  const events = eventSignatures.map((sig) => parseAbiItem(sig.replace("tuple", "")) as AbiEvent);
  const address = spokePoolAddr as `0x${string}`;
  // Floor for the trailing window: the first block seen on the primary subscription (set in its
  // first `onBlock`). It sits at the chain head, one past the startup scrape, so flooring here stops
  // the initial poll from re-querying — and re-submitting — already-scraped blocks. Shared across all
  // providers (a lagging secondary's own first block could fall inside the scraped range).
  let liveFrom: bigint | undefined;

  // Fetch a single provider's logs for a block it has just announced and feed its votes to
  // EventManager. Replaces viem's filter-based `watchEvent` (TRON expires filter ids) while keeping
  // its per-provider sourcing: each provider polls only blocks it has itself seen, so a provider
  // that briefly lags or fails still contributes its quorum vote once it catches up.
  const pollLogs = async (provider: (typeof providers)[number], head: bigint): Promise<void> => {
    if (liveFrom === undefined) {
      return; // Primary hasn't reported its first block yet; nothing to floor the window at.
    }
    const floor = liveFrom;
    const lookback = head > LOG_RETRY_DEPTH ? head - LOG_RETRY_DEPTH : 0n;
    const fromBlock = lookback > floor ? lookback : floor;
    if (fromBlock > head) {
      return; // Provider hasn't advanced past the first live block yet; nothing to poll.
    }
    const getLogs = () => provider.getLogs({ address, events, fromBlock, toBlock: head });
    // TRON RPCs intermittently return empty bodies; retry inline, then leave the block to be
    // re-polled on the next tick (the trailing window) rather than dropping its logs.
    const rawLogs = await retry(getLogs, 3, 1).catch((error: BaseError) => {
      const { message: errorMessage, details, shortMessage, metaMessages } = error;
      logger.warn({
        at,
        message: `Caught ${chain} getLogs error.`,
        errorMessage,
        shortMessage,
        details,
        metaMessages,
        provider: provider.name,
        fromBlock: Number(fromBlock),
        toBlock: Number(head),
      });
      return undefined;
    });
    if (!isDefined(rawLogs)) {
      return;
    }

    for (const raw of rawLogs) {
      const log: Log = {
        ...raw,
        args: raw.args,
        blockNumber: Number(raw.blockNumber),
        event: raw.eventName,
        topics: Array<string>(),
      };

      if (eventMgr.add(log, provider.name) && !postEvents([log])) {
        abortController.abort();
      }
    }
  };

  const logBlockError = (provider: (typeof providers)[number], error: Error): void => {
    const { message: errorMessage, details, shortMessage, metaMessages } = error as BaseError;
    logger.warn({
      at,
      message: `Caught ${chain} block error.`,
      errorMessage,
      shortMessage,
      details,
      metaMessages,
      provider: provider.name,
    });
  };

  // The primary provider owns re-org detection and the block heartbeat (via processBlock), and polls
  // its own logs. `emitMissed` keeps the block stream contiguous so getLogs polling doesn't skip
  // blocks and processBlock's parent-hash chain stays intact.
  const [blockProvider, ...secondaryProviders] = providers;
  blockProvider.watchBlocks({
    emitOnBegin: true,
    emitMissed: true,
    onBlock: (block: Block) => {
      const { orphans, accepted } = processBlock(block, blocks, eventMgr, chain, blockProvider.name, logger);
      if (!accepted) {
        return;
      }
      for (const orphan of orphans) {
        if (!removeEvent({ ...orphan, removed: true })) {
          abortController.abort();
          return;
        }
      }
      // Pending blocks have a null number; skip them rather than posting block 0.
      if (!isDefined(block.number)) {
        return;
      }
      // The first block seen here floors the trailing window for every provider.
      liveFrom ??= block.number;
      if (!postBlock(Number(block.number), Number(block.timestamp))) {
        abortController.abort();
      }
      void pollLogs(blockProvider, block.number);
    },
    onError: (error: Error) => logBlockError(blockProvider, error),
  });

  // Secondary providers poll their own logs independently, so each contributes its quorum vote at
  // its own pace.
  for (const provider of secondaryProviders) {
    provider.watchBlocks({
      emitOnBegin: true,
      emitMissed: true,
      onBlock: (block: Block) => {
        if (!isDefined(block.number)) {
          return;
        }
        void pollLogs(provider, block.number);
      },
      onError: (error: Error) => logBlockError(provider, error),
    });
  }

  return waitForAbort(abortController.signal);
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

  const quorumProvider = await getProvider(chainId);
  const blockFinder: undefined = undefined;
  const cache = await getRedisCache();
  const latestBlock = await quorumProvider.getBlock("latest");

  // Deployment-block registry also lacks TVM entries; default to 0 so `scrapeEvents`
  // can still bound the lookback window.
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

  const opts = {
    spokePool: spokePoolAddr,
    deploymentBlock,
    lookback: latestBlock.number - startBlock,
    maxBlockRange,
    quorum,
  };

  logger.debug({ at, message: `Starting ${chain} SpokePool Indexer.`, opts });

  logger.debug({ at, message: `Scraping previous ${chain} events.`, opts });

  if (latestBlock.number > startBlock) {
    const events = [
      "FundsDeposited",
      "FilledRelay",
      "RequestedSpeedUpDeposit",
      "RelayedRootBundle",
      "ExecutedRelayerRefundRoot",
    ];

    const _spokePool = spokePool.connect(quorumProvider);
    const { address, interface: abi, provider } = _spokePool;
    const signatures = events.map((event) => abi.getEvent(event).format(ethersUtils.FormatTypes.full));
    await scrapeEvents(address, signatures, provider, opts);
  }

  const events = ["FundsDeposited", "FilledRelay"];
  const signatures = events.map((event) => spokePool.interface.getEvent(event).format(ethersUtils.FormatTypes.full));

  logger.debug({ at, message: `Starting ${chain} listener.`, events, opts });

  const eventMgr = new EventManager(logger, chainId, quorum);
  await listen(eventMgr, spokePoolAddr, signatures, quorum);
}

if (require.main === module) {
  logger = Logger;
  bootstrap({ program: PROGRAM, abortController, chainName: () => chain, run });
}

import assert from "assert";
import minimist from "minimist";
import { Contract, utils as ethersUtils } from "ethers";
import { AbiEvent, BaseError, Block, createPublicClient, http, Log as viemLog, parseAbiItem } from "viem";
import * as utils from "../../scripts/utils";
import { Log } from "../interfaces";
import {
  disconnectRedisClients,
  EventManager,
  exit,
  isDefined,
  getBlockForTimestamp,
  getChainQuorum,
  getDeploymentBlockNumber,
  getNetworkName,
  getNodeUrlList,
  getOriginFromURL,
  getProvider,
  getProviderHeaders,
  getRedisCache,
  getViemChain,
  Logger,
  Provider,
  SpokePool,
  winston,
} from "../utils";
import { ScraperOpts } from "./types";
import { postBlock, postEvents, removeEvent } from "./util/ipc";
import { scrapeEvents as _scrapeEvents } from "./util/evm";

const { NODE_SUCCESS, NODE_APP_ERR } = utils;

const PROGRAM = "RelayerSpokePoolListenerTVM";
export const REORG_WINDOW = 128n;
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
  const urls = Object.values(getNodeUrlList(chainId, quorum, "https"));
  const nProviders = urls.length;
  assert(nProviders >= quorum, `Insufficient providers for ${chain} (minimum ${quorum} required by quorum)`);

  const viemChain = getViemChain(chainId);
  return Object.entries(urls).map(([provider, url]) => {
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

  const [blockProvider] = providers;
  blockProvider.watchBlocks({
    emitOnBegin: true,
    onBlock: (block: Block) => {
      const { orphans, accepted } = processBlock(block, blocks, eventMgr, chain, blockProvider.name, logger);
      if (!accepted) {
        return;
      }
      for (const orphan of orphans) {
        removeEvent({ ...orphan, removed: true });
      }
      if (!postBlock(Number(block.number), Number(block.timestamp))) {
        abortController.abort();
      }
    },
    onError: (error: Error) => {
      const { message: errorMessage, details, shortMessage, metaMessages } = error as BaseError;
      logger.warn({
        at,
        message: `Caught ${chain} block error.`,
        errorMessage,
        shortMessage,
        details,
        metaMessages,
        provider: blockProvider.name,
      });
    },
  });

  for (const sig of eventSignatures) {
    const event = parseAbiItem(sig.replace("tuple", "")) as AbiEvent;
    for (const provider of providers) {
      provider.watchEvent({
        address: spokePoolAddr as `0x${string}`,
        event,
        onLogs: (rawLogs: (viemLog & { args: unknown; eventName: string })[]) => {
          for (const raw of rawLogs) {
            const log: Log = {
              ...raw,
              args: raw.args,
              blockNumber: Number(raw.blockNumber),
              event: raw.eventName,
              topics: Array<string>(),
            };

            if (log.removed) {
              eventMgr.remove(log, provider.name);
              removeEvent(log);
              continue;
            }

            if (eventMgr.add(log, provider.name) && !postEvents([log])) {
              abortController.abort();
            }
          }
        },
        onError: (error: Error) => {
          const { message: errorMessage, details, shortMessage, metaMessages } = error as BaseError;
          logger.warn({
            at,
            message: `Caught ${chain} ${event.name} provider error.`,
            errorMessage,
            shortMessage,
            details,
            metaMessages,
            provider: provider.name,
          });
        },
      });
    }
  }

  return new Promise((resolve) => abortController.signal.addEventListener("abort", () => resolve()));
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

  process.on("SIGHUP", () => {
    logger.debug({ at, message: `Received SIGHUP in ${chain} listener, stopping...` });
    abortController.abort();
  });

  process.on("disconnect", () => {
    logger.debug({ at, message: `${chain} parent disconnected, stopping...` });
    abortController.abort();
  });

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
  const at = PROGRAM;
  logger = Logger;

  run(process.argv.slice(2))
    .then(() => {
      process.exitCode = NODE_SUCCESS;
    })
    .catch((error) => {
      logger.error({ at, message: `${chain} listener exited with error.`, error });
      process.exitCode = NODE_APP_ERR;
    })
    .finally(async () => {
      await disconnectRedisClients();
      logger.debug({ at, message: `Exiting ${chain} listener.` });
      exit(Number(process.exitCode));
    });
}

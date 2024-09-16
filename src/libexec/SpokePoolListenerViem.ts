import assert from "assert";
import minimist from "minimist";
import { Contract, EventFilter, providers as ethersProviders, utils as ethersUtils } from "ethers";
import { BaseError, Block, createPublicClient, Log as viemLog, webSocket } from "viem";
import * as chains from "viem/chains";
import { utils as sdkUtils } from "@across-protocol/sdk";
import * as utils from "../../scripts/utils";
import { Log } from "../interfaces";
import { SpokePoolClientMessage } from "../clients";
import {
  CHAIN_IDs,
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
  getRedisCache,
  Logger,
  paginatedEventQuery,
  sortEventsAscending,
  winston,
} from "../utils";

type EventSearchConfig = sdkUtils.EventSearchConfig;
type ScraperOpts = {
  lookback?: number; // Event lookback (in seconds).
  deploymentBlock: number; // SpokePool deployment block
  maxBlockRange?: number; // Maximum block range for paginated getLogs queries.
  filterArgs?: { [event: string]: string[] }; // Event-specific filter criteria to apply.
};

const { NODE_SUCCESS, NODE_APP_ERR } = utils;

const INDEXER_POLLING_PERIOD = 2_000; // ms; time to sleep between checking for exit request via SIGHUP.

let logger: winston.Logger;
let chainId: number;
let chain: string;
let stop = false;
let oldestTime = 0;

// This mapping is necessary because viem imposes extremely narrow type inference. @todo: Improve?
const _chains = {
  [CHAIN_IDs.ARBITRUM]: chains.arbitrum,
  [CHAIN_IDs.BASE]: chains.base,
  [CHAIN_IDs.BLAST]: chains.blast,
  [CHAIN_IDs.LINEA]: chains.linea,
  [CHAIN_IDs.LISK]: chains.lisk,
  [CHAIN_IDs.MAINNET]: chains.mainnet,
  [CHAIN_IDs.MODE]: chains.mode,
  [CHAIN_IDs.OPTIMISM]: chains.optimism,
  [CHAIN_IDs.POLYGON]: chains.polygon,
  [CHAIN_IDs.REDSTONE]: chains.redstone,
  [CHAIN_IDs.SCROLL]: chains.scroll,
  [CHAIN_IDs.ZK_SYNC]: chains.zksync,
  [CHAIN_IDs.ZORA]: chains.zora,
} as const;

BigInt.prototype["toJSON"] = function () {
  return this.toString();
};

/**
 * Given an event name and contract, return the corresponding Ethers EventFilter object.
 * @param contract Ethers Constract instance.
 * @param eventName The name of the event to be filtered.
 * @param filterArgs Optional filter arguments to be applied.
 * @returns An Ethers EventFilter instance.
 */
function getEventFilter(contract: Contract, eventName: string, filterArgs?: string[]): EventFilter {
  const filter = contract.filters[eventName];
  if (!isDefined(filter)) {
    throw new Error(`Event ${eventName} not defined for contract`);
  }

  return isDefined(filterArgs) ? filter(...filterArgs) : filter();
}

function getEventFilterArgs(relayer?: string): { [event: string]: string[] } {
  const FilledV3Relay = !isDefined(relayer)
    ? undefined
    : [null, null, null, null, null, null, null, null, null, null, relayer];

  return { FilledV3Relay };
}

/**
 * Given the inputs for a SpokePoolClient update, consolidate the inputs into a message and submit it to the parent
 * process (if defined).
 * @param blockNumber Block number up to which the update applies.
 * @param currentTime The SpokePool timestamp at blockNumber.
 * @param events An array of Log objects to be submitted.
 * @returns void
 */
function postEvents(blockNumber: number, currentTime: number, events: Log[]): void {
  if (!isDefined(process.send) || stop) {
    return;
  }

  // Drop the array component of event.args and retain the named k/v pairs,
  // otherwise stringification tends to retain only the array.
  events = sortEventsAscending(events);

  const message: SpokePoolClientMessage = {
    blockNumber,
    currentTime,
    oldestTime,
    nEvents: events.length,
    data: JSON.stringify(events, sdkUtils.jsonReplacerWithBigNumbers),
  };

  process.send(JSON.stringify(message));
}

/**
 * Given an event removal notification, post the message to the parent process.
 * @param event Log instance.
 * @returns void
 */
function removeEvent(event: Log): void {
  if (!isDefined(process.send) || stop) {
    return;
  }

  const message: SpokePoolClientMessage = {
    event: JSON.stringify(event, sdkUtils.jsonReplacerWithBigNumbers),
  };
  process.send(JSON.stringify(message));
}

/**
 * Given a SpokePool contract instance and an event name, scrape all corresponding events and submit them to the
 * parent process (if defined).
 * @param spokePool Ethers Constract instance.
 * @param eventName The name of the event to be filtered.
 * @param opts Options to configure event scraping behaviour.
 * @returns void
 */
async function scrapeEvents(spokePool: Contract, eventName: string, opts: ScraperOpts): Promise<void> {
  const { lookback, deploymentBlock, filterArgs, maxBlockRange } = opts;
  const { provider } = spokePool;

  let tStart: number, tStop: number;

  const pollEvents = async (filter: EventFilter, searchConfig: EventSearchConfig): Promise<Log[]> => {
    tStart = performance.now();
    const events = await paginatedEventQuery(spokePool, filter, searchConfig);
    tStop = performance.now();
    logger.debug({
      at: "SpokePoolIndexer::scrapeEvents",
      message: `Indexed ${events.length} ${chain} events in ${Math.round((tStop - tStart) / 1000)} seconds`,
      searchConfig,
    });
    return events;
  };

  const { number: toBlock, timestamp: currentTime } = await provider.getBlock("latest");
  const fromBlock = Math.max(toBlock - (lookback ?? deploymentBlock), deploymentBlock);
  assert(toBlock > fromBlock, `${toBlock} > ${fromBlock}`);
  const searchConfig = { fromBlock, toBlock, maxBlockLookBack: maxBlockRange };

  const filter = getEventFilter(spokePool, eventName, filterArgs[eventName]);
  const events = await pollEvents(filter, searchConfig);
  postEvents(toBlock, currentTime, events);
}

/**
 * Given a SpokePool contract instance and an array of event names, subscribe to all future event emissions.
 * Periodically transmit received events to the parent process (if defined).
 * @param eventMgr Ethers Constract instance.
 * @param eventName The name of the event to be filtered.
 * @param opts Options to configure event scraping behaviour.
 * @returns void
 */
async function listen(eventMgr: EventManager, spokePool: Contract, eventNames: string[], quorum = 1): Promise<void> {
  const urls = getNodeUrlList(chainId, quorum, "wss");
  let nProviders = urls.length;
  assert(nProviders >= quorum, `Insufficient providers for ${chain} (required ${quorum} by quorum)`);

  const providers = urls.map((url) =>
    createPublicClient({
      chain: _chains[chainId],
      transport: webSocket(url, { name: getOriginFromURL(url) }),
    })
  );

  // On each new block, submit any "finalised" events.
  const newBlock = (block: Block) => {
    const [blockNumber, currentTime] = [parseInt(block.number.toString()), parseInt(block.timestamp.toString())];
    const events = eventMgr.tick(blockNumber);
    postEvents(blockNumber, currentTime, events);
  };

  const blockError = (error: Error, provider: string) => {
    const at = "RelayerSpokePoolIndexer::run";
    const message = `Caught ${chain} provider error.`;
    const { message: errorMessage, details, shortMessage, metaMessages } = error as BaseError;
    logger.debug({ at, message, errorMessage, shortMessage, provider, details, metaMessages });

    if (!stop && --nProviders < quorum) {
      stop = true;
      logger.warn({
        at: "RelayerSpokePoolIndexer::run",
        message: `Insufficient ${chain} providers to continue.`,
        quorum,
        nProviders,
      });
    }
  };

  providers.forEach((provider, idx) => {
    if (idx === 0) {
      provider.watchBlocks({
        emitOnBegin: true,
        onBlock: (block: Block) => newBlock(block),
        onError: (error: Error) => blockError(error, provider.name),
      });
    }

    const abi = JSON.parse(spokePool.interface.format(ethersUtils.FormatTypes.json) as string);
    eventNames.forEach((eventName) => {
      provider.watchContractEvent({
        address: spokePool.address as `0x${string}`,
        abi,
        eventName,
        onLogs: (logs: viemLog[]) =>
          logs.forEach((log) => {
            const event = {
              ...log,
              args: log["args"],
              blockNumber: Number(log.blockNumber),
              event: log["eventName"],
              topics: [],
            };
            if (log.removed) {
              eventMgr.remove(event, provider.name);
              removeEvent(event);
            } else {
              eventMgr.add(event, provider.name);
            }
          }),
      });
    });
  });

  do {
    await sdkUtils.delay(INDEXER_POLLING_PERIOD);
  } while (!stop);
}

/**
 * Main entry point.
 */
async function run(argv: string[]): Promise<void> {
  const minimistOpts = {
    string: ["lookback", "relayer"],
  };
  const args = minimist(argv, minimistOpts);

  ({ chainId } = args);
  const { lookback, relayer = null, maxBlockRange = 10_000 } = args;
  assert(Number.isInteger(chainId), "chainId must be numeric ");
  assert(Number.isInteger(maxBlockRange), "maxBlockRange must be numeric");
  assert(!isDefined(relayer) || ethersUtils.isAddress(relayer), `relayer address is invalid (${relayer})`);

  const { quorum = getChainQuorum(chainId) } = args;
  assert(Number.isInteger(quorum), "quorum must be numeric ");

  chain = getNetworkName(chainId);

  const quorumProvider = await getProvider(chainId);
  const blockFinder = undefined;
  const cache = await getRedisCache();
  const latestBlock = await quorumProvider.getBlock("latest");

  const deploymentBlock = getDeploymentBlockNumber("SpokePool", chainId);
  let startBlock = latestBlock.number;
  if (/^@[0-9]+$/.test(lookback)) {
    // Lookback to a specific block (lookback = @<block-number>).
    startBlock = Number(lookback.slice(1));
  } else if (isDefined(lookback)) {
    // Resolve `lookback` seconds from head to a specific block.
    assert(Number.isInteger(Number(lookback)), `Invalid lookback (${lookback})`);
    startBlock = Math.max(
      deploymentBlock,
      await getBlockForTimestamp(chainId, latestBlock.timestamp - lookback, blockFinder, cache)
    );
  } else {
    logger.debug({ at: "RelayerSpokePoolIndexer::run", message: `Skipping lookback on ${chain}.` });
  }

  const opts = {
    quorum,
    deploymentBlock,
    lookback: latestBlock.number - startBlock,
    maxBlockRange,
    filterArgs: getEventFilterArgs(relayer),
  };

  logger.debug({ at: "RelayerSpokePoolIndexer::run", message: `Starting ${chain} SpokePool Indexer.`, opts });
  const spokePool = await utils.getSpokePoolContract(chainId);

  process.on("SIGHUP", () => {
    logger.debug({ at: "Relayer#run", message: `Received SIGHUP in ${chain} listener, stopping...` });
    stop = true;
  });

  process.on("disconnect", () => {
    logger.debug({ at: "Relayer::run", message: `${chain} parent disconnected, stopping...` });
    stop = true;
  });

  // Note: An event emitted between scrapeEvents() and listen(). @todo: Ensure that there is overlap and dedpulication.
  logger.debug({ at: "RelayerSpokePoolIndexer::run", message: `Scraping previous ${chain} events.`, opts });

  // The SpokePoolClient reports on the timestamp of the oldest block searched. The relayer likely doesn't need this,
  // but resolve it anyway for consistency with the main SpokePoolClient implementation.
  const resolveOldestTime = async (spokePool: Contract, blockTag: ethersProviders.BlockTag) => {
    oldestTime = (await spokePool.getCurrentTime({ blockTag })).toNumber();
  };

  if (latestBlock.number > startBlock) {
    const events = ["V3FundsDeposited", "FilledV3Relay", "RelayedRootBundle", "ExecutedRelayerRefundRoot"];
    const _spokePool = spokePool.connect(quorumProvider);
    await Promise.all([
      resolveOldestTime(_spokePool, startBlock),
      ...events.map((event) => scrapeEvents(_spokePool, event, opts)),
    ]);
  }

  // If no lookback was specified then default to the timestamp of the latest block.
  oldestTime ??= latestBlock.timestamp;

  // Events to listen for.
  const events = ["V3FundsDeposited", "FilledV3Relay"];
  const eventMgr = new EventManager(logger, chainId, quorum);

  logger.debug({ at: "RelayerSpokePoolIndexer::run", message: `Starting ${chain} listener.`, events, opts });
  await listen(eventMgr, spokePool, events, quorum);
}

if (require.main === module) {
  logger = Logger;

  run(process.argv.slice(2))
    .then(() => {
      process.exitCode = NODE_SUCCESS;
    })
    .catch((error) => {
      logger.error({ at: "RelayerSpokePoolIndexer", message: `${chain} listener exited with error.`, error });
      process.exitCode = NODE_APP_ERR;
    })
    .finally(async () => {
      await disconnectRedisClients();
      logger.debug({ at: "RelayerSpokePoolIndexer", message: `Exiting ${chain} listener.` });
      exit(process.exitCode);
    });
}

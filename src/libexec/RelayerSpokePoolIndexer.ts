import assert from "assert";
import minimist from "minimist";
import { setTimeout } from "node:timers/promises";
import { Contract, Event, EventFilter, providers as ethersProviders, utils as ethersUtils } from "ethers";
import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import * as utils from "../../scripts/utils";
import { SpokePoolClientMessage } from "../clients";
import {
  disconnectRedisClients,
  EventManager,
  exit,
  isDefined,
  getBlockForTimestamp,
  getDeploymentBlockNumber,
  getNetworkName,
  getOriginFromURL,
  getProvider,
  getRedisCache,
  getWSProviders,
  Logger,
  mangleEventArgs,
  paginatedEventQuery,
  sortEventsAscending,
  winston,
  BlockFinder,
} from "../utils";

type WebSocketProvider = ethersProviders.WebSocketProvider;
type EventSearchConfig = sdkUtils.EventSearchConfig;
type ScraperOpts = {
  lookback?: number; // Event lookback (in seconds).
  finality?: number; // Event finality (in blocks).
  quorum?: number; // Provider quorum to apply.
  deploymentBlock: number; // SpokePool deployment block
  maxBlockRange?: number; // Maximum block range for paginated getLogs queries.
  filterArgs?: { [event: string]: string[] }; // Event-specific filter criteria to apply.
};

const { NODE_SUCCESS, NODE_APP_ERR } = utils;

const INDEXER_POLLING_PERIOD = 2000; // ms; time to sleep between checking for exit request via SIGHUP.

let logger: winston.Logger;
let chain: string;
let stop = false;
let oldestTime = 0;

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
 * @param events An array of Ethers Event objects to be submitted.
 * @returns void
 */
function postEvents(blockNumber: number, currentTime: number, events: Event[]): void {
  if (!isDefined(process.send) || stop) {
    return;
  }

  // Drop the array component of event.args and retain the named k/v pairs,
  // otherwise stringification tends to retain only the array.
  events = sortEventsAscending(events.map(mangleEventArgs));

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
 * @param event Ethers Event instance.
 * @returns void
 */
function removeEvent(event: Event): void {
  if (!isDefined(process.send) || stop) {
    return;
  }

  const message: SpokePoolClientMessage = {
    event: JSON.stringify(mangleEventArgs(event), sdkUtils.jsonReplacerWithBigNumbers),
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
  const { chainId } = await provider.getNetwork();
  const chain = getNetworkName(chainId);

  let tStart: number, tStop: number;

  const pollEvents = async (filter: EventFilter, searchConfig: EventSearchConfig): Promise<Event[]> => {
    tStart = performance.now();
    const events = await paginatedEventQuery(spokePool, filter, searchConfig);
    tStop = performance.now();
    logger.debug({
      at: "SpokePoolIndexer::listen",
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
async function listen(
  eventMgr: EventManager,
  spokePool: Contract,
  eventNames: string[],
  providers: WebSocketProvider[],
  opts: ScraperOpts
): Promise<void> {
  assert(providers.length > 0);

  const { filterArgs } = opts;

  // On each new block, submit any "finalised" events.
  // ethers block subscription drops most useful information, notably the timestamp for new blocks.
  // The "official unofficial" strategy is to use an internal provider method to subscribe.
  // See also: https://github.com/ethers-io/ethers.js/discussions/1951#discussioncomment-1229670
  await providers[0]._subscribe("newHeads", ["newHeads"], ({ number: blockNumber, timestamp: currentTime }) => {
    [blockNumber, currentTime] = [parseInt(blockNumber), parseInt(currentTime)];
    const events = eventMgr.tick(blockNumber);

    // Post an update to the parent. Do this irrespective of whether there were new events or not, since there's
    // information in blockNumber and currentTime alone.
    postEvents(blockNumber, currentTime, events);
  });

  // Add a handler for each new instance of a subscribed event.
  providers.forEach((provider) => {
    const host = getOriginFromURL(provider.connection.url);
    eventNames.forEach((eventName) => {
      const filter = getEventFilter(spokePool, eventName, filterArgs[eventName]);
      spokePool.connect(provider).on(filter, (...rawEvent) => {
        const event = rawEvent.at(-1);
        if (event.removed) {
          eventMgr.remove(event, host);
          // Notify the parent immediately in case the event was already submitted.
          removeEvent(event);
        } else {
          eventMgr.add(event, host);
        }
      });
    });
  });

  do {
    await setTimeout(INDEXER_POLLING_PERIOD);
  } while (!stop);
}

/**
 * Main entry point.
 */
async function run(argv: string[]): Promise<void> {
  const minimistOpts = {
    string: ["relayer"],
  };
  const args = minimist(argv, minimistOpts);

  const { chainId, finality = 32, quorum = 1, lookback = 7200, relayer = null, maxBlockRange = 10_000 } = args;
  assert(Number.isInteger(chainId), "chainId must be numeric ");
  assert(Number.isInteger(finality), "finality must be numeric ");
  assert(Number.isInteger(quorum), "quorum must be numeric ");
  assert(Number.isInteger(lookback), "lookback must be numeric");
  assert(Number.isInteger(maxBlockRange), "maxBlockRange must be numeric");
  assert(!isDefined(relayer) || ethersUtils.isAddress(relayer), "relayer address is invalid");

  chain = getNetworkName(chainId);

  const quorumProvider = await getProvider(chainId);
  const blockFinder: BlockFinder = undefined;
  const cache = await getRedisCache();
  const latestBlock = await quorumProvider.getBlock("latest");

  const deploymentBlock = getDeploymentBlockNumber("SpokePool", chainId);
  const startBlock = Math.max(
    deploymentBlock,
    await getBlockForTimestamp(chainId, latestBlock.timestamp - lookback, blockFinder, cache)
  );
  const nBlocks = latestBlock.number - startBlock;

  const opts = {
    finality,
    quorum,
    deploymentBlock,
    lookback: nBlocks,
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

  if (lookback > 0) {
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
  const events = ["V3FundsDeposited", "RequestedSpeedUpV3Deposit", "FilledV3Relay"];
  const eventMgr = new EventManager(logger, chainId, finality, quorum);
  do {
    let providers: WebSocketProvider[] = [];
    try {
      providers = getWSProviders(chainId, quorum);
      assert(providers.length > 0, `Insufficient providers for ${chain} (required ${quorum} by quorum)`);
      providers.forEach((provider) => {
        provider.on("error", (err) =>
          logger.debug({ at: "RelayerSpokePoolIndexer::run", message: `Caught ${chain} provider error.`, err })
        );

        provider.on("close", () => {
          logger.debug({
            at: "RelayerSpokePoolIndexer::run",
            message: `${chain} provider connection closed.`,
            provider: getOriginFromURL(provider.connection.url),
          });
        });
      });

      logger.debug({ at: "RelayerSpokePoolIndexer::run", message: `Starting ${chain} listener.`, events, opts });
      await listen(eventMgr, spokePool, events, providers, opts);
    } catch (err) {
      providers.forEach((provider) => provider.removeAllListeners());

      // @todo: What to do if the websocket drops? Should be able to reconnect?
      logger.warn({
        at: "RelayerSpokePoolIndexer::run",
        message: "Caught runtime error.",
        err,
      });
      throw err;
    }
  } while (!stop);
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

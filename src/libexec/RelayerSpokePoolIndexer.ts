import assert from "assert";
import minimist from "minimist";
import { setTimeout } from "node:timers/promises";
import { Contract, Event, EventFilter, providers as ethersProviders, utils as ethersUtils } from "ethers";
import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import * as utils from "../../scripts/utils";
import { SpokePoolClientMessage } from "../clients";
import {
  disconnectRedisClients,
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
  paginatedEventQuery,
  sortEventsAscending,
  winston,
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

const INDEXER_POLLING_PERIOD = 2000; // ms; time to sleep between checking for exit request via SIGUP.

let logger: winston.Logger;
let chain: string;
let stop = false;
let oldestTime = 0;

class EventManager {
  public readonly chain: string;
  public readonly events: { [blockNumber: number]: (Event & { providers: string[] })[] } = {};

  private blockNumber: number;

  constructor(
    private readonly logger: winston.Logger,
    public readonly chainId: number,
    public readonly finality: number,
    public readonly quorum: number
  ) {
    chain = getNetworkName(chainId);
    this.blockNumber = 0;
  }

  /**
   * Use a number of key attributes from an Ethers event to find any corresponding stored event. Note that this does
   * not guarantee an exact 1:1 match for the complete event. This is not possible without excluding numerous fields
   * on a per-event basis, because some providers append implementation-specific information to events. Rather, it
   * relies on known important fields matching.
   * @param event Event to search for.
   * @returns The matching event, or undefined.
   */
  findEvent(event: Event): (Event & { providers: string[] }) | undefined {
    return this.events[event.blockNumber]?.find(
      (storedEvent) =>
        storedEvent.logIndex === event.logIndex &&
        storedEvent.transactionIndex === event.transactionIndex &&
        storedEvent.transactionHash === event.transactionHash &&
        this.hashEvent(storedEvent) === this.hashEvent(event)
    );
  }

  /**
   * For a given Ethers Event, identify its quorum based on the number of unique providers that have supplied it.
   * @param event An Ethers Event with appended provider information.
   * @returns The number of unique providers that reported this event.
   */
  getEventQuorum(event: Event & { providers: string[] }): number {
    return sdkUtils.dedupArray(event.providers).length;
  }

  /**
   * Record an Ethers event. If quorum is 1 then the event will be enqueued for transfer. If this is a new event and
   * quorum > 1 then its hash will be recorded for future reference. If the same event is received multiple times then
   * it will be enqueued for transfer. This applies a rudimentary quorum system to the event and ensures that providers
   * agree on the events being transmitted.
   * @param event Ethers event to be recorded.
   * @param provider A string uniquely identifying the provider that supplied the event.
   * @returns void
   */
  add(event: Event, provider: string): void {
    assert(!event.removed);

    // If `eventHash` is not recorded in `eventHashes` then it's presumed to be a new event. If it is
    // already found in the `eventHashes` array, then at least one provider has already supplied it.
    const events = (this.events[event.blockNumber] ??= []);
    const storedEvent = this.findEvent(event);

    // Store or update the set of events for this block number.
    if (!isDefined(storedEvent)) {
      // Event hasn't been seen before, so store it.
      events.push({ ...event, providers: [provider] });
    } else {
      if (!storedEvent.providers.includes(provider)) {
        // Event has been seen before, but not from this provider. Store it.
        storedEvent.providers.push(provider);
      }
    }
  }

  /**
   * Remove an Ethers event. This event may have previously been ingested, and subsequently invalidated due to a chain
   * re-org. The EventManager does not necessarily know whether it's seen this event before, so it initially attempts
   * to flush the event from its local pending buffer and subsequently propagates the removal to the parent process
   * for further processing (if defined).
   * @param event Ethers event to be recorded.
   * @param provider A string uniquely identifying the provider that supplied the event.
   * @returns void
   */
  remove(event: Event, provider: string): void {
    assert(event.removed);

    const events = this.events[event.blockNumber] ?? [];

    // Filter coarsely on transactionHash, since a reorg should invalidate multiple events within a single transaction hash.
    const eventIdxs = events
      .map((event, idx) => ({ ...event, idx }))
      .filter(({ blockHash }) => blockHash === event.blockHash)
      .map(({ idx }) => idx);

    if (eventIdxs.length > 0) {
      // Remove each event in reverse to ensure that indexes remain valid until the last has been removed.
      eventIdxs.reverse().forEach((idx) => events.splice(idx, 1));

      this.logger.warn({
        at: "EventManager::remove",
        message: `Dropped ${eventIdxs.length} event(s) at ${this.chain} block ${event.blockNumber}.`,
        provider,
      });

      // Notify the SpokePoolClient immediately in case the reorg is deeper then the configured finality. Batch these
      // by transactionHash, but recognise that multiple different events may have occurred in the same transaction.
      removeEvent(event);
    }
  }

  /**
   * Record a new block. This function triggers the existing queue of pending events to be evaluated for basic finality.
   * Events meeting finality criteria are submitted to the parent process (if defined). Events submitted are
   * subsequently flushed from this class.
   * @param blockNumber Number of the latest block.
   * @returns void
   */
  tick(blockNumber: number, currentTime: number): void {
    this.blockNumber = blockNumber > this.blockNumber ? blockNumber : this.blockNumber;

    // After `finality` blocks behind head, events for a block are considered finalised.
    // This is configurable and will almost always be less than chain finality guarantees.
    const finalised = blockNumber - this.finality;

    // Collect the events that met quorum, strip out the provider information, and mangle the results for sending.
    const events = (this.events[finalised] ?? [])
      .filter((event) => this.getEventQuorum(event) >= this.quorum)
      .map(({ providers, ...event }) => mangleEvent(event));

    // Post an update to the parent. Do this irrespective of whether there were new events or not, since there's
    // information in blockNumber and currentTIme alone.
    postEvents(blockNumber, currentTime, events);

    // Flush the events that were just submitted.
    delete this.events[finalised];
  }

  /**
   * Produce a SHA256 hash representing an Ethers event, based on select input fields.
   * @param event An Ethers event to be hashed.
   * @returns A SHA256 string derived from the event.
   */
  hashEvent(event: Event): string {
    const { event: eventName, blockNumber, blockHash, transactionHash, transactionIndex, logIndex, args } = event;
    return ethersUtils.id(
      `${eventName}-${blockNumber}-${blockHash}-${transactionHash}-${transactionIndex}-${logIndex}-${args.join("-")}`
    );
  }
}

/**
 * Sub out the array component of `args` to ensure it's correctly stringified before transmission.
 * Stringification of an Ethers event can produce unreliable results for Event.args and it can be consolidated into an
 * array, dropping the named k/v pairs.
 * @param event An Ethers event.
 * @returns A modified Ethers event, ensuring that the Event.args object consists of named k/v pairs.
 */
function mangleEvent(event: Event): Event {
  return { ...event, args: sdkUtils.spreadEvent(event.args) };
}

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
  if (!isDefined(process.send)) {
    return;
  }

  const message: SpokePoolClientMessage = {
    blockNumber,
    currentTime,
    oldestTime,
    nEvents: events.length,
    data: JSON.stringify(sortEventsAscending(events), sdkUtils.jsonReplacerWithBigNumbers),
  };
  process.send(JSON.stringify(message));
}

/**
 * Given an event removal notification, post the message to the parent process.
 * @param event Ethers Event instance.
 * @returns void
 */
function removeEvent(event: Event): void {
  if (!isDefined(process.send)) {
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
  postEvents(toBlock, currentTime, events.map(mangleEvent));
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
  // https://github.com/ethers-io/ethers.js/discussions/1951#discussioncomment-1229670
  await providers[0]._subscribe("newHeads", ["newHeads"], ({ number: blockNumber, timestamp }) =>
    eventMgr.tick(parseInt(blockNumber), parseInt(timestamp))
  );

  // Add a handler for each new instance of a subscribed.
  providers.forEach((provider) => {
    const host = getOriginFromURL(provider.connection.url);
    eventNames.forEach((eventName) => {
      const filter = getEventFilter(spokePool, eventName, filterArgs[eventName]);
      spokePool.connect(provider).on(filter, (...rawEvent) => {
        const event = rawEvent.at(-1);
        if (event.removed) {
          eventMgr.remove(event, host);
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
  assert(Number.isInteger(lookback), "lookback must be numeric");
  assert(Number.isInteger(maxBlockRange), "maxBlockRange must be numeric");
  assert(!isDefined(relayer) || ethersUtils.isAddress(relayer), "relayer address is invalid");

  chain = getNetworkName(chainId);

  const provider = await getProvider(chainId);
  const blockFinder = undefined;
  const cache = await getRedisCache();
  const latestBlock = await provider.getBlock("latest");

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
    logger.debug({ at: "Relayer#run", message: "Received SIGHUP, stopping..." });
    stop = true;
  });

  // EnabledDepositRoutes should always look back over the entire history.
  // @note: An improvement is on the way...
  // Note: An event emitted between scrapeEvents() and listen(). @todo: Ensure that there is overlap and dedpulication.
  logger.debug({ at: "RelayerSpokePoolIndexer::run", message: `Scraping previous ${chain} events.`, opts });

  // The SpokePoolClient reports on the timestamp of the oldest block searched. The relayer likely doesn't need this,
  // but resolve it anyway for consistency with the main SpokePoolClient implementation.
  const resolveOldestTime = async (blockTag: ethersProviders.BlockTag) => {
    oldestTime = (await spokePool.connect(provider).getCurrentTime({ blockTag })).toNumber();
  };

  if (lookback > 0) {
    await Promise.all([
      resolveOldestTime(startBlock),
      scrapeEvents(spokePool.connect(provider), "EnabledDepositRoute", { ...opts, lookback: undefined }),
      scrapeEvents(spokePool.connect(provider), "V3FundsDeposited", opts),
      scrapeEvents(spokePool.connect(provider), "FilledV3Relay", opts),
      scrapeEvents(spokePool.connect(provider), "RelayedRootBundle", opts),
      scrapeEvents(spokePool.connect(provider), "ExecutedRelayerRefundRoot", opts),
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
      logger.error({ at: "RelayerSpokePoolIndexer", message: "Process exited with error.", error });
      process.exitCode = NODE_APP_ERR;
    })
    .finally(async () => {
      await disconnectRedisClients();
      exit(process.exitCode);
    });
}

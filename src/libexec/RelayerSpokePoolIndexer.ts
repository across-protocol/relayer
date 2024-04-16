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
  getNodeUrlList,
  getOriginFromURL,
  getProvider,
  getRedisCache,
  Logger,
  paginatedEventQuery,
  sortEventsAscending,
  winston,
} from "../utils";

type WebSocketProvider = ethersProviders.WebSocketProvider;
type EventSearchConfig = sdkUtils.EventSearchConfig;
type ScraperOpts = {
  period?: number; // Polling update period.
  lookback?: number; // Event lookback (in seconds).
  finality?: number; // Event finality (in blocks).
  quorum?: number; // Provider quorum to apply.
  deploymentBlock: number; // SpokePool deployment block
  maxBlockRange?: number; // Maximum block range for paginated getLogs queries.
  filterArgs?: string[]; // Event-specific filter criteria to apply.
};

const { NODE_SUCCESS, NODE_APP_ERR } = utils;

let logger: winston.Logger;
let chain: string;
let stop = false;

class EventManager {
  public readonly chain: string;
  public readonly eventHashes: { [blockNumber: number]: string[] } = {};
  public readonly events: { [eventHash: string]: Event } = {};

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
   * Record an Ethers event. If quorum is 1 then the event will be enqueued for transfer. If this is a new event and
   * quorum > 1 then its hash will be recorded for future reference. If the same event is received multiple times then
   * it will be enqueued for transfer. This applies a rudimentary quorum system to the event and ensures that providers
   * agree on the events being transmitted.
   * @param event Ethers event to be recorded.
   * @param provider A string uniquely identifying the provider that supplied the event.
   * @returns void
   */
  add(event: Event, provider: string): void {
    provider; // @todo: Store the provider to ensure that quorum is satisfied by separate providers.
    assert(!event.removed);

    const eventHash = this.hashEvent(event);

    // If `eventHash` is not recorded in `eventHashes` then it's presumed to be a new event. If it is
    // already found in the `eventHashes` array, then at least one provider has already supplied it.
    const eventHashes = (this.eventHashes[event.blockNumber] ??= []);
    const idx = eventHashes.indexOf(eventHash);
    if (idx === -1) {
      eventHashes.push(eventHash);
    }

    if (idx !== -1 || this.quorum === 1) {
      this.events[eventHash] = event;
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
    provider; // @todo: TBD whether this is needed here.
    assert(event.removed);

    const { blockNumber } = event;
    const eventHash = this.hashEvent(event);

    const eventHashes = (this.eventHashes[blockNumber] ??= []);
    const idx = eventHashes.indexOf(eventHash);
    if (idx !== -1) {
      eventHashes.splice(idx, 1); // Drop the event hash from `blockNumber`;
    }
    delete this.events[eventHash]; // Drop the event entirely.

    // Notify the SpokePoolClient immediately in case the reorg is deeper then the configured finality.
    removeEvent(event);
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

    const finalised = blockNumber - this.finality;
    const eventHashes = this.eventHashes[finalised] ?? [];

    // Collect the finalised events for sending.
    const events = eventHashes
      .map((eventHash) => this.events[eventHash])
      .filter((event) => isDefined(event) && finalised >= event.blockNumber)
      .map(mangleEvent);

    postEvents(blockNumber, currentTime, events);

    // Flush the confirmed events.
    eventHashes.forEach((eventHash) => delete this.events[eventHash]);
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
function getEventFilter(contract: Contract, eventName: string, filterArgs: string[] = []): EventFilter {
  const filter = contract.filters[eventName];
  if (!isDefined(filter)) {
    throw new Error(`Event ${eventName} not defined for contract`);
  }

  filterArgs; // @todo

  return filter();
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
  assert(event.removed);
  if (!isDefined(process.send)) {
    return;
  }

  const message: SpokePoolClientMessage = {
    event: JSON.stringify(mangleEvent(event), sdkUtils.jsonReplacerWithBigNumbers),
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

  const filter = getEventFilter(spokePool, eventName, filterArgs);
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

  const { period, filterArgs } = opts;

  // On each new block, submit any "finalised" events.
  // @todo: Should probably prune blocks and events > 100x finality.
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
      const filter = getEventFilter(spokePool, eventName, filterArgs);
      spokePool.connect(provider).on(filter, (...rawEvent) => {
        const event = rawEvent.at(-1);
        (event.removed ? eventMgr.remove : eventMgr.add).bind(eventMgr)(event, host);
      });
    });
  });

  // @todo: Periodically submit to the parent process on this loop.
  const delay = period * 1000;
  do {
    await setTimeout(delay);
  } while (!stop);
}

function getWSProviders(chainId: number, quorum = 1): WebSocketProvider[] {
  const urls = getNodeUrlList(chainId, quorum, "wss");
  const providers = urls.map((url: string) => new ethersProviders.WebSocketProvider(url));
  return providers;
}

/**
 * Main entry point.
 */
async function run(argv: string[]): Promise<void> {
  const args = minimist(argv);

  const { chainId, finality = 32, quorum = 1, period = 60, lookback = 7200, relayer, maxBlockRange = 10_000 } = args;
  assert(Number.isInteger(chainId), "chainId must be numeric ");
  assert(Number.isInteger(finality), "finality must be numeric ");
  assert(Number.isInteger(period), "period must be numeric ");
  assert(Number.isInteger(lookback), "lookback must be numeric");
  assert(Number.isInteger(maxBlockRange), "maxBlockRange must be numeric");
  assert(!isDefined(relayer) !== ethersUtils.isAddress(relayer), "relayer address is invalid");

  chain = getNetworkName(chainId);

  const provider = await getProvider(chainId);
  const blockFinder = undefined;
  const cache = await getRedisCache();
  const latestBlock = await provider.getBlock("latest");
  const startBlock = await getBlockForTimestamp(chainId, latestBlock.timestamp - lookback, blockFinder, cache);
  const nBlocks = latestBlock.number - startBlock;

  const opts = {
    finality,
    quorum,
    period,
    deploymentBlock: getDeploymentBlockNumber("SpokePool", chainId),
    lookback: nBlocks,
    maxBlockRange,
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
  if (lookback > 0) {
    await Promise.all([
      scrapeEvents(spokePool.connect(provider), "EnabledDepositRoute", { ...opts, lookback: undefined }),
      scrapeEvents(spokePool.connect(provider), "V3FundsDeposited", opts),
      scrapeEvents(spokePool.connect(provider), "FilledV3Relay", opts),
      scrapeEvents(spokePool.connect(provider), "RelayedRootBundle", opts),
      scrapeEvents(spokePool.connect(provider), "ExecutedRelayerRefundRoot", opts),
    ]);
  }

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

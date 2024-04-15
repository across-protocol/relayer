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

  add(event: Event, provider: string): void {
    provider; // @todo: Store the provider to ensure that quorum is satisfied by separate providers.
    assert(!event.removed);

    const eventHash = this.hashEvent(event);

    const eventHashes = (this.eventHashes[event.blockNumber] ??= []);
    if (eventHashes.indexOf(eventHash) === -1) {
      eventHashes.push(eventHash);
    } else {
      this.events[eventHash] = event;
    }
  }

  remove(event: Event, provider: string): void {
    provider; // @todo: TBD whether this is needed here.
    assert(event.removed);

    const { blockNumber } = event;
    const eventHash = this.hashEvent(event);
    const eventHashes = this.eventHashes[blockNumber];

    const idx = eventHashes.indexOf(eventHash);
    if (idx !== -1) {
      eventHashes.splice(idx, 1); // Drop the event hash from `blockNumber`;
    }

    delete this.events[eventHash]; // Drop the event entirely.

    // Notify the SpokePoolClient in case the reorg is deeper then the configured finality.
    const message = {
      event: JSON.stringify(mangleEvent(event), sdkUtils.jsonReplacerWithBigNumbers),
    };
    process.send(JSON.stringify(message));
  }

  tick(blockNumber: number): void {
    this.blockNumber = blockNumber > this.blockNumber ? blockNumber : this.blockNumber;

    const finalised = blockNumber - this.finality;
    const eventHashes = this.eventHashes[finalised] ?? [];

    // Collect the finalised events for sending.
    const events = eventHashes
      .map((eventHash) => this.events[eventHash])
      .filter((event) => isDefined(event) && finalised >= event.blockNumber)
      .map(mangleEvent);

    const currentTime = Math.floor(Date.now() / 1000); // @todo
    postEvents(blockNumber, currentTime, events);

    // Flush the confirmed events.
    eventHashes.forEach((eventHash) => delete this.events[eventHash]);
  }

  hashEvent(event: Event): string {
    const { event: eventName, blockNumber, blockHash, transactionHash, transactionIndex, logIndex, args } = event;
    return ethersUtils.id(
      `${eventName}-${blockNumber}-${blockHash}-${transactionHash}-${transactionIndex}-${logIndex}-${args.join("-")}`
    );
  }
}

/**
 * Stringification of an Ethers event produces unreliable results for Event.args and it can be consolidated into an
 * array, dropping the named k/v pairs. Sub out the array component of `args` to ensure it's parsed correctly on the
 * receiving side.
 */
function mangleEvent(event: Event): Event {
  return { ...event, args: sdkUtils.spreadEvent(event.args) };
}

function getEventFilter(contract: Contract, eventName: string, filterArgs: string[]): EventFilter {
  const filter = contract.filters[eventName];
  if (!isDefined(filter)) {
    throw new Error(`Event ${eventName} not defined for contract`);
  }

  filterArgs; // @todo

  return filter();
}

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

async function listen(
  eventMgr: EventManager,
  spokePool: Contract,
  eventNames: string[],
  providers: WebSocketProvider[],
  opts: ScraperOpts
): Promise<void> {
  assert(providers.length > 0);

  const { period, filterArgs } = opts;

  const filters = eventNames.map((event) => getEventFilter(spokePool, event, filterArgs));

  // On each new block, submit any "finalised" events.
  // @todo: Should probably prune blocks and events > 100x finality.
  providers[0].on("block", (blockNumber) => eventMgr.tick(blockNumber));

  // Setup listeners for each supplied provider.
  providers.forEach((provider) => {
    const host = getOriginFromURL(provider.connection.url);
    filters.forEach((filter) =>
      spokePool.connect(provider).on(filter, (...rawEvent) => {
        const event = rawEvent.at(-1);
        (event.removed ? eventMgr.remove : eventMgr.add).bind(eventMgr)(event, host);
      })
    );
  });

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
  await Promise.all([
    scrapeEvents(spokePool.connect(provider), "EnabledDepositRoute", { ...opts, lookback: undefined }),
    scrapeEvents(spokePool.connect(provider), "V3FundsDeposited", opts),
    scrapeEvents(spokePool.connect(provider), "FilledV3Relay", opts),
    scrapeEvents(spokePool.connect(provider), "RelayedRootBundle", opts),
    scrapeEvents(spokePool.connect(provider), "ExecutedRelayerRefundRoot", opts),
  ]);

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

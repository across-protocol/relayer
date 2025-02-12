import assert from "assert";
import minimist from "minimist";
import { Contract, providers as ethersProviders, utils as ethersUtils } from "ethers";
import { utils as sdkUtils } from "@across-protocol/sdk";
import * as utils from "../../scripts/utils";
import {
  disconnectRedisClients,
  EventManager,
  exit,
  isDefined,
  getBlockForTimestamp,
  getChainQuorum,
  getDeploymentBlockNumber,
  getNetworkName,
  getOriginFromURL,
  getProvider,
  getRedisCache,
  getSpokePool,
  getWSProviders,
  Logger,
  winston,
} from "../utils";
import { postEvents, removeEvent } from "./util/ipc";
import { ScraperOpts } from "./types";
import { getEventFilter, getEventFilterArgs, scrapeEvents as _scrapeEvents } from "./util/evm";

type WebSocketProvider = ethersProviders.WebSocketProvider;
const { NODE_SUCCESS, NODE_APP_ERR } = utils;

const INDEXER_POLLING_PERIOD = 2_000; // ms; time to sleep between checking for exit request via SIGHUP.
const WS_PING_INTERVAL = 20_000; // ms
const WS_PONG_TIMEOUT = WS_PING_INTERVAL / 2;

let logger: winston.Logger;
let chain: string;
let stop = false;

/**
 * Aggregate utils/scrapeEvents for a series of event names.
 * @param spokePool Ethers Constract instance.
 * @param eventNames The array of events to be queried.
 * @param opts Options to configure event scraping behaviour.
 * @returns void
 */
export async function scrapeEvents(spokePool: Contract, eventNames: string[], opts: ScraperOpts): Promise<void> {
  const { number: toBlock, timestamp: currentTime } = await spokePool.provider.getBlock("latest");
  const events = await Promise.all(
    eventNames.map((eventName) => _scrapeEvents(spokePool, eventName, { ...opts, toBlock }, logger))
  );

  if (!stop) {
    postEvents(toBlock, currentTime, events.flat());
  }
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
    if (!stop) {
      postEvents(blockNumber, currentTime, events);
    }
  });

  // Add a handler for each new instance of a subscribed event.
  providers.forEach((provider) => {
    const host = getOriginFromURL(provider.connection.url);
    eventNames.forEach((eventName) => {
      const filter = getEventFilter(spokePool, eventName, filterArgs[eventName]);
      spokePool.connect(provider).on(filter, (...rawEvent) => {
        const event = sdkUtils.eventToLog(rawEvent.at(-1));
        if (event.removed) {
          eventMgr.remove(event, host);
          // Notify the parent immediately in case the event was already submitted.
          if (!stop) {
            removeEvent(event);
          }
        } else {
          eventMgr.add(event, host);
        }
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
    string: ["lookback", "relayer", "spokepool"],
  };
  const args = minimist(argv, minimistOpts);

  const { chainid: chainId, lookback, relayer = null, blockrange: maxBlockRange = 10_000 } = args;
  assert(Number.isInteger(chainId), "chainId must be numeric ");
  assert(Number.isInteger(maxBlockRange), "maxBlockRange must be numeric");
  assert(!isDefined(relayer) || ethersUtils.isAddress(relayer), `relayer address is invalid (${relayer})`);

  const { quorum = getChainQuorum(chainId) } = args;
  assert(Number.isInteger(quorum), "quorum must be numeric ");

  let { spokepool: spokePoolAddr } = args;
  assert(
    !isDefined(spokePoolAddr) || ethersUtils.isAddress(spokePoolAddr),
    `Invalid SpokePool address (${spokePoolAddr})`
  );

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

  const spokePool = getSpokePool(chainId, spokePoolAddr);
  if (!isDefined(spokePoolAddr)) {
    ({ address: spokePoolAddr } = spokePool);
  }

  const opts = {
    spokePool: spokePoolAddr,
    deploymentBlock,
    lookback: latestBlock.number - startBlock,
    maxBlockRange,
    filterArgs: getEventFilterArgs(relayer),
    quorum,
  };

  logger.debug({ at: "RelayerSpokePoolIndexer::run", message: `Starting ${chain} SpokePool Indexer.`, opts });

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

  if (latestBlock.number > startBlock) {
    const events = [
      "FundsDeposited",
      "FilledRelay",
      "RequestedSpeedUpDeposit",
      "RelayedRootBundle",
      "ExecutedRelayerRefundRoot",
    ];
    const _spokePool = spokePool.connect(quorumProvider);
    await scrapeEvents(_spokePool, events, opts);
  }

  // Events to listen for.
  const events = ["FundsDeposited", "FilledRelay"];
  const eventMgr = new EventManager(logger, chainId, quorum);
  const providers = getWSProviders(chainId, quorum);
  let nProviders = providers.length;
  assert(providers.length > 0, `Insufficient providers for ${chain} (required ${quorum} by quorum)`);

  providers.forEach((provider) => {
    const { _websocket: ws } = provider;
    const _provider = getOriginFromURL(provider.connection.url);
    let interval: NodeJS.Timer | undefined;
    let timeout: NodeJS.Timeout | undefined;

    const closeProvider = () => {
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }

      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }

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

    // On connection, start an interval timer to periodically ping the remote end.
    ws.on("open", () => {
      interval = setInterval(() => {
        ws.ping();
        timeout = setTimeout(() => {
          logger.warn({
            at: "RelayerSpokePoolIndexer::run",
            message: `Timed out on ${chain} provider.`,
            provider: _provider,
          });
          ws.terminate();
        }, WS_PONG_TIMEOUT);
      }, WS_PING_INTERVAL);
    });

    // Pong received; cancel the timeout.
    ws.on("pong", () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
    });

    // Oops, something went wrong.
    ws.on("error", (err) => {
      const at = "RelayerSpokePoolIndexer::run";
      const message = `Caught ${chain} provider error.`;
      logger.debug({ at, message, provider: _provider, quorum, nProviders, err });
      closeProvider();
    });

    // Websocket is gone.
    ws.on("close", () => {
      logger.debug({
        at: "RelayerSpokePoolIndexer::run",
        message: `${chain} provider connection closed.`,
        provider: _provider,
      });
      closeProvider();
    });
  });

  logger.debug({ at: "RelayerSpokePoolIndexer::run", message: `Starting ${chain} listener.`, events, opts });
  await listen(eventMgr, spokePool, events, providers, opts);

  // Cleanup where possible.
  providers.forEach((provider) => provider._websocket.terminate());
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

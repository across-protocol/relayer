import assert from "assert";
import minimist from "minimist";
import { Contract, utils as ethersUtils } from "ethers";
import { BaseError, Block, createPublicClient, http, Log as viemLog, webSocket } from "viem";
import * as chains from "viem/chains";
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
  getNodeUrlList,
  getOriginFromURL,
  getProvider,
  getProviderHeaders,
  getSpokePool,
  getRedisCache,
  Logger,
  winston,
} from "../utils";
import { ScraperOpts } from "./types";
import { postEvents, removeEvent } from "./util/ipc";
import { getEventFilterArgs, scrapeEvents as _scrapeEvents } from "./util/evm";

const { NODE_SUCCESS, NODE_APP_ERR } = utils;

const PROGRAM = "RelayerSpokePoolListener";
const INDEXER_POLLING_PERIOD = 2_000; // ms; time to sleep between checking for exit request via SIGHUP.

let providers: ReturnType<typeof resolveProviders>;
let spokePool: Contract;
let logger: winston.Logger;
let chainId: number;
let chain: string;
let stop = false;

// Teach BigInt how to be represented as JSON.
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

/**
 * Instantiate websocket providers.
 * @param chainId Chain ID of network.
 * @param quorum Minimum number of providers required.
 * @returns An array of websocket providers.
 */
function resolveProviders(chainId: number, quorum = 1) {
  const protocol = process.env[`RPC_PROVIDERS_TRANSPORT_${chainId}`] ?? "wss";
  assert(protocol === "wss" || protocol === "https");

  const urls = Object.values(getNodeUrlList(chainId, quorum, protocol));
  const nProviders = urls.length;
  assert(nProviders >= quorum, `Insufficient providers for ${chain} (minimum ${quorum} required by quorum)`);

  const viemChain = Object.values(chains).find(({ id }) => id === chainId);
  const providers = Object.entries(urls).map(([provider, url]) => {
    const headers = getProviderHeaders(provider, chainId);
    const transport = protocol === "wss" ? webSocket(url) : http(url, { fetchOptions: { headers } });

    return createPublicClient({
      chain: viemChain,
      transport,
      name: getOriginFromURL(url),
    });
  });

  return providers;
}

/**
 * Aggregate utils/scrapeEvents for a series of event names.
 * @param spokePool Ethers Contract instance.
 * @param eventNames The array of events to be queried.
 * @param opts Options to configure event scraping behaviour.
 * @returns void
 */
async function scrapeEvents(spokePool: Contract, eventNames: string[], opts: ScraperOpts): Promise<void> {
  const { address, interface: abi, provider } = spokePool;
  const { number: toBlock, timestamp: currentTime } = await provider.getBlock("latest");

  const events = await Promise.all(
    eventNames.map((eventName) => {
      const event = abi.getEvent(eventName).format(ethersUtils.FormatTypes.full);
      return _scrapeEvents(provider, address, event, { ...opts, toBlock }, logger);
    })
  );

  if (!stop) {
    postEvents(toBlock, currentTime, events.flat());
  }
}

/**
 * Setup a newHeads subscription.
 * @param eventMgr Event Manager instance.
 * @returns void
 */
function subNewHeads(eventMgr: EventManager): void {
  const at = `${PROGRAM}::newHeads`;

  // On each new block, submit any "finalised" events.
  const newBlock = (block: Block, provider: string) => {
    // Transient error that sometimes occurs in production. Catch it here and try to flush out the provider.
    if (!block) {
      logger.debug({ at, message: `Received empty ${chain} block from ${provider}.` });
      return;
    }
    const [blockNumber, currentTime] = [parseInt(block.number.toString()), parseInt(block.timestamp.toString())];
    const events = eventMgr.tick();
    if (!postEvents(blockNumber, currentTime, events)) {
      stop = true;
    }
  };

  const blockError = (error: Error, provider: string) => {
    const message = `Caught ${chain} provider error.`;
    const { message: errorMessage, details, shortMessage, metaMessages } = error as BaseError;
    logger.debug({ at, message, errorMessage, shortMessage, provider, details, metaMessages });
  };

  const [provider] = providers;
  provider.watchBlocks({
    emitOnBegin: true,
    onBlock: (block: Block) => newBlock(block, provider.name),
    onError: (error: Error) => blockError(error, provider.name),
  });
}

/**
 * Given a SpokePool contract instance and an array of event names, subscribe to all future event emissions.
 * Periodically transmit received events to the parent process (if defined).
 * @param eventMgr Ethers Contract instance.
 * @param spokePool ethers SpokePool contract instances.
 * @param eventName The name of the event to be filtered.
 * @returns void
 */
function subEvents(eventMgr: EventManager, spokePool: Contract, eventNames: string[]): void {
  const abi = JSON.parse(spokePool.interface.format(ethersUtils.FormatTypes.json) as string);

  providers.forEach((provider) => {
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
              topics: [], // Not supplied by viem, but not actually used by the relayer.
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
}

/**
 * Main entry point.
 */
async function run(argv: string[]): Promise<void> {
  const at = `${PROGRAM}::run`;

  const minimistOpts = {
    string: ["lookback", "relayer", "spokepool"],
  };
  const args = minimist(argv, minimistOpts);

  ({ chainid: chainId } = args);
  const { lookback, relayer = null, blockrange: maxBlockRange = 10_000 } = args;
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
      await getBlockForTimestamp(logger, chainId, latestBlock.timestamp - lookback, blockFinder, cache)
    );
  } else {
    logger.debug({ at, message: `Skipping lookback on ${chain}.` });
  }

  spokePool = getSpokePool(chainId, spokePoolAddr);
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

  logger.debug({ at, message: `Starting ${chain} SpokePool Indexer.`, opts });

  process.on("SIGHUP", () => {
    logger.debug({ at, message: `Received SIGHUP in ${chain} listener, stopping...` });
    stop = true;
  });

  process.on("disconnect", () => {
    logger.debug({ at, message: `${chain} parent disconnected, stopping...` });
    stop = true;
  });

  // Note: An event emitted between scrapeEvents() and listen(). @todo: Ensure that there is overlap and deduplication.
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
    await scrapeEvents(_spokePool, events, opts);
  }

  // Events to listen for.
  const events = ["FundsDeposited", "FilledRelay"];
  const eventMgr = new EventManager(logger, chainId, quorum);
  providers = resolveProviders(chainId, quorum);

  logger.debug({ at, message: `Starting ${chain} listener.`, events, opts });

  subNewHeads(eventMgr);
  subEvents(eventMgr, spokePool, events);

  do {
    await sdkUtils.delay(INDEXER_POLLING_PERIOD);
  } while (!stop);
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

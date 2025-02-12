import assert from "assert";
import minimist from "minimist";
import { Contract, utils as ethersUtils } from "ethers";
import { BaseError, Block, createPublicClient, Log as viemLog, webSocket } from "viem";
import * as chains from "viem/chains";
import { utils as sdkUtils } from "@across-protocol/sdk";
import * as utils from "../../scripts/utils";
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
  getSpokePool,
  getRedisCache,
  Logger,
  winston,
} from "../utils";
import { ScraperOpts } from "./types";
import { postEvents, removeEvent } from "./util/ipc";
import { getEventFilterArgs, scrapeEvents as _scrapeEvents } from "./util/evm";

const { NODE_SUCCESS, NODE_APP_ERR } = utils;

const INDEXER_POLLING_PERIOD = 2_000; // ms; time to sleep between checking for exit request via SIGHUP.

let logger: winston.Logger;
let chainId: number;
let chain: string;
let stop = false;

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
  [CHAIN_IDs.WORLD_CHAIN]: chains.worldchain,
  [CHAIN_IDs.ZK_SYNC]: chains.zksync,
  [CHAIN_IDs.ZORA]: chains.zora,
} as const;

// Teach BigInt how to be represented as JSON.
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

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
async function listen(eventMgr: EventManager, spokePool: Contract, eventNames: string[], quorum = 1): Promise<void> {
  const urls = getNodeUrlList(chainId, quorum, "wss");
  let nProviders = urls.length;
  assert(nProviders >= quorum, `Insufficient providers for ${chain} (required ${quorum} by quorum)`);

  const providers = urls.map((url) =>
    createPublicClient({
      chain: _chains[chainId],
      transport: webSocket(url),
      name: getOriginFromURL(url),
    })
  );

  // On each new block, submit any "finalised" events.
  const newBlock = (block: Block) => {
    const [blockNumber, currentTime] = [parseInt(block.number.toString()), parseInt(block.timestamp.toString())];
    const events = eventMgr.tick(blockNumber);
    postEvents(blockNumber, currentTime, events);
  };

  const blockError = (error: Error, provider: string) => {
    const at = "RelayerSpokePoolListener::run";
    const message = `Caught ${chain} provider error.`;
    const { message: errorMessage, details, shortMessage, metaMessages } = error as BaseError;
    logger.debug({ at, message, errorMessage, shortMessage, provider, details, metaMessages });

    if (!stop && --nProviders < quorum) {
      stop = true;
      logger.warn({
        at: "RelayerSpokePoolListener::run",
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
      await getBlockForTimestamp(chainId, latestBlock.timestamp - lookback, blockFinder, cache)
    );
  } else {
    logger.debug({ at: "RelayerSpokePoolListener::run", message: `Skipping lookback on ${chain}.` });
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

  logger.debug({ at: "RelayerSpokePoolListener::run", message: `Starting ${chain} SpokePool Indexer.`, opts });

  process.on("SIGHUP", () => {
    logger.debug({ at: "Relayer#run", message: `Received SIGHUP in ${chain} listener, stopping...` });
    stop = true;
  });

  process.on("disconnect", () => {
    logger.debug({ at: "Relayer::run", message: `${chain} parent disconnected, stopping...` });
    stop = true;
  });

  // Note: An event emitted between scrapeEvents() and listen(). @todo: Ensure that there is overlap and dedpulication.
  logger.debug({ at: "RelayerSpokePoolListener::run", message: `Scraping previous ${chain} events.`, opts });

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

  logger.debug({ at: "RelayerSpokePoolListener::run", message: `Starting ${chain} listener.`, events, opts });
  await listen(eventMgr, spokePool, events, quorum);
}

if (require.main === module) {
  logger = Logger;

  run(process.argv.slice(2))
    .then(() => {
      process.exitCode = NODE_SUCCESS;
    })
    .catch((error) => {
      logger.error({ at: "RelayerSpokePoolListener", message: `${chain} listener exited with error.`, error });
      process.exitCode = NODE_APP_ERR;
    })
    .finally(async () => {
      await disconnectRedisClients();
      logger.debug({ at: "RelayerSpokePoolListener", message: `Exiting ${chain} listener.` });
      exit(process.exitCode);
    });
}

import assert from "assert";
import minimist from "minimist";
import { Contract, utils as ethersUtils } from "ethers";
import * as utils from "../../scripts/utils";
import { EventListener } from "../clients";
import {
  disconnectRedisClients,
  exit,
  isDefined,
  getBlockForTimestamp,
  getChainQuorum,
  getDeploymentBlockNumber,
  getNetworkName,
  getProvider,
  getSpokePool,
  getRedisCache,
  Logger,
  Provider,
  winston,
} from "../utils";
import { ScraperOpts } from "./types";
import { postBlock, postEvents, removeEvent } from "./util/ipc";
import { scrapeEvents as _scrapeEvents } from "./util/evm";

const { NODE_SUCCESS, NODE_APP_ERR } = utils;

const PROGRAM = "RelayerSpokePoolListener";
const abortController = new AbortController();

let spokePool: Contract;
let logger: winston.Logger;
let chainId: number;
let chain: string;

/**
 * Aggregate utils/scrapeEvents for a series of event names.
 * @param address A contract address to query.
 * @param eventSignatures An array of event signatures to be queried.
 * @param provider An Ethers provider instance.
 * @param opts Options to configure event scraping behaviour.
 * @returns void
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

  let { spokepool: spokePoolAddr } = args;
  assert(
    !isDefined(spokePoolAddr) || ethersUtils.isAddress(spokePoolAddr),
    `Invalid SpokePool address (${spokePoolAddr})`
  );

  chain = getNetworkName(chainId);

  // Register signal/disconnect handlers before any awaits so the listener can abort
  // if the parent dies during startup.
  process.on("SIGHUP", () => {
    logger.debug({ at, message: `Received SIGHUP in ${chain} listener, stopping...` });
    abortController.abort();
  });

  process.on("disconnect", () => {
    logger.debug({ at, message: `${chain} parent disconnected, stopping...` });
    abortController.abort();
  });

  const quorumProvider = await getProvider(chainId);
  const blockFinder: undefined = undefined;
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
    quorum,
  };

  logger.debug({ at, message: `Starting ${chain} SpokePool Indexer.`, opts });

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
    const { address, interface: abi, provider } = _spokePool;
    const signatures = events.map((event) => abi.getEvent(event).format(ethersUtils.FormatTypes.full));
    await scrapeEvents(address, signatures, provider, opts);
  }

  // Events to listen for.
  const events = ["FundsDeposited", "FilledRelay"];
  const signatures = events.map((event) => spokePool.interface.getEvent(event).format(ethersUtils.FormatTypes.full));

  logger.debug({ at, message: `Starting ${chain} listener.`, events, opts });

  const listener = new EventListener(chainId, logger, quorum);
  listener.onBlock((blockNumber, currentTime) => {
    if (!postBlock(blockNumber, currentTime)) {
      abortController.abort();
    }
  });
  listener.onEvents(spokePoolAddr, signatures, (log) => {
    const ok = log.removed ? removeEvent(log) : postEvents([log]);
    if (!ok) {
      abortController.abort();
    }
  });

  return new Promise((resolve) => abortController.signal.addEventListener("abort", () => resolve()));
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

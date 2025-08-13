import assert from "assert";
import minimist from "minimist";
import { address, createSolanaRpcSubscriptions, RpcSubscriptions, SolanaRpcSubscriptionsApi } from "@solana/kit";
import { arch } from "@across-protocol/sdk";
import { SvmSpokeClient } from "@across-protocol/contracts";
import { Log } from "../interfaces";
import * as utils from "../../scripts/utils";
import {
  disconnectRedisClients,
  EventManager,
  exit,
  isDefined,
  getBlockForTimestamp,
  getChainQuorum,
  getCurrentTime,
  getDeploymentBlockNumber,
  getNetworkName,
  getNodeUrlList,
  getOriginFromURL,
  getRedisCache,
  getSvmProvider,
  Logger,
  winston,
} from "../utils";
import { ScraperOpts } from "./types";
import { postEvents } from "./util/ipc";
import { scrapeEvents as _scrapeEvents } from "./util/svm";

type WSProvider = RpcSubscriptions<SolanaRpcSubscriptionsApi>;
type EventWithData = arch.svm.EventWithData;

const { NODE_SUCCESS, NODE_APP_ERR } = utils;
const abortController = new AbortController();

let logger: winston.Logger;
let chainId: number;
let chain: string;

// Teach BigInt how to be represented as JSON.
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

// These are Log fields that are irrelevant for SVM and are only needed for the messaging interface.
// These will ultimately be dropped from the messaging interface.
const UNUSED_FIELDS = {
  blockHash: "",
  transactionIndex: 0,
  logIndex: 0,
  data: "",
  topics: [],
};

/**
 * Transform an EventWithData type to a Log type.
 * @notice This conversion will be redundant after changes to the SpokePoolListener messaging interface.
 * @param event EventWithData instance.
 * @returns Log
 */
function logFromEvent(event: Pick<EventWithData, "slot" | "program" | "signature" | "name" | "data">): Log {
  return {
    ...UNUSED_FIELDS,
    transactionHash: event.signature,
    blockNumber: Number(event.slot),
    address: event.program,
    event: event.name,
    removed: false,
    args: arch.svm.unwrapEventData(event.data),
  };
}

/**
 * Aggregate utils/scrapeEvents for a series of event names.
 * @param spokePool Ethers Contract instance.
 * @param eventNames The array of events to be queried.
 * @param opts Options to configure event scraping behaviour.
 * @returns void
 */
async function scrapeEvents(
  eventsClient: arch.svm.SvmCpiEventsClient,
  eventNames: string[],
  opts: ScraperOpts & { to: bigint }
): Promise<void> {
  const provider = eventsClient.getRpc();
  const [{ timestamp: currentTime }, ...events] = await Promise.all([
    arch.svm.getNearestSlotTime(provider, { commitment: "confirmed" }, logger),
    ...eventNames.map((eventName) => _scrapeEvents(chain, eventsClient, eventName, { ...opts, to: opts.to }, logger)),
  ]);

  if (!abortController.signal.aborted) {
    if (!postEvents(Number(opts.to), currentTime, events.flat().map(logFromEvent))) {
      abortController.abort();
    }
  }
}

/**
 * Given a SpokePool eventsClient instance and an array of event names, subscribe to all future event emissions.
 * Periodically transmit received events to the parent process (if defined).
 * @param eventMgr Event manager instancea.
 * @param eventsClient eventsClient instance.
 * @param eventNames Event names to listen for.
 * @param quorum Minimum quorum requirement for events.
 * @returns void
 */
async function listen(
  eventMgr: EventManager,
  eventsClient: arch.svm.SvmCpiEventsClient,
  eventNames: string[],
  quorum = 1
): Promise<void> {
  const urls = Object.values(getNodeUrlList(chainId, quorum, "wss"));
  const nProviders = urls.length;
  assert(nProviders >= quorum, `Insufficient providers for ${chain} (required ${quorum} by quorum)`);

  const eventAuthority = await arch.svm.getEventAuthority(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS);
  const config = { commitment: "confirmed" } as const;
  const { signal: abortSignal } = abortController;
  const providers = urls.map((url) => createSolanaRpcSubscriptions(url));

  const readSlot = async (provider: WSProvider) => {
    const subscription = await provider.slotNotifications().subscribe({ abortSignal });

    for await (const update of subscription) {
      const { slot } = update as { slot: bigint }; // Bodge: pretend slots are blocks.
      const currentTime = getCurrentTime(); // @todo Try to subscribe w/ timestamp updates.
      const events = eventMgr.tick();
      if (!postEvents(Number(slot), currentTime, events)) {
        abortController.abort();
      }
    }
  };

  const readEvent = async (provider: WSProvider, providerName: string) => {
    const subscription = await provider
      .logsNotifications({ mentions: [address(eventAuthority)] }, config)
      .subscribe({ abortSignal });

    for await (const log of subscription) {
      const { signature } = log.value;
      const rawEvents = await eventsClient.readEventsFromSignature(signature, "confirmed");

      const events = rawEvents
        .filter(({ name }) => eventNames.includes(name))
        .map((event) => logFromEvent({ ...event, signature, slot: log.context.slot }));

      events.forEach((event) => eventMgr.add(event, providerName));
    }
  };

  const providerNames = urls.map(getOriginFromURL);
  await Promise.all([readSlot(providers[0]), ...providers.map((provider, i) => readEvent(provider, providerNames[i]))]);
}

/**
 * Main entry point.
 */
async function run(argv: string[]): Promise<void> {
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

  chain = getNetworkName(chainId);

  const provider = getSvmProvider(await getRedisCache());
  const blockFinder = undefined;
  const { slot: latestSlot, timestamp: now } = await arch.svm.getNearestSlotTime(
    provider,
    { commitment: "confirmed" },
    logger
  );

  const deploymentBlock = getDeploymentBlockNumber("SvmSpoke", chainId);
  let startSlot = latestSlot;
  if (/^@[0-9]+$/.test(lookback)) {
    // Lookback to a specific block (lookback = @<block-number>).
    startSlot = BigInt(lookback.slice(1));
  } else if (isDefined(lookback)) {
    // Resolve `lookback` seconds from head to a specific block.
    assert(Number.isInteger(Number(lookback)), `Invalid lookback (${lookback})`);

    assert(typeof now === "bigint"); // Should be unnecessary; tsc still complains.
    startSlot = BigInt(
      Math.max(
        deploymentBlock,
        await getBlockForTimestamp(logger, chainId, Number(now - BigInt(lookback)), blockFinder, await getRedisCache())
      )
    );
  } else {
    logger.debug({ at: "RelayerSpokePoolListener::run", message: `Skipping lookback on ${chain}.` });
  }

  const opts = {
    quorum,
    deploymentBlock,
    lookback: Number(latestSlot - startSlot),
  };

  logger.debug({ at: "RelayerSpokePoolListener::run", message: `Starting ${chain} SpokePool Indexer.`, opts });

  process.on("SIGHUP", () => {
    logger.debug({ at: "Relayer#run", message: `Received SIGHUP in ${chain} listener, stopping...` });
    abortController.abort();
  });

  process.on("disconnect", () => {
    logger.debug({ at: "Relayer::run", message: `${chain} parent disconnected, stopping...` });
    abortController.abort();
  });

  const eventsClient = await arch.svm.SvmCpiEventsClient.create(getSvmProvider());
  if (latestSlot > startSlot) {
    const events = ["FundsDeposited", "FilledRelay", "RelayedRootBundle", "ExecutedRelayerRefundRoot"];
    await scrapeEvents(eventsClient, events, { ...opts, to: latestSlot });
  }

  const events = ["FundsDeposited", "FilledRelay"];
  logger.debug({ at: "RelayerSpokePoolListener::run", message: `Starting ${chain} listener.`, events, opts });
  const eventMgr = new EventManager(logger, chainId, quorum);

  await listen(eventMgr, eventsClient, events, quorum);
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
      exit(Number(process.exitCode));
    });
}

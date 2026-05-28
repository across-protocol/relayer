import assert from "assert";
import minimist from "minimist";
import { address, createSolanaRpcSubscriptions, RpcSubscriptions, SolanaRpcSubscriptionsApi } from "@solana/kit";
import { arch, typeguards } from "@across-protocol/sdk";
import { SvmSpokeClient } from "@across-protocol/contracts";
import { Log } from "../interfaces";
import {
  abortableDelay,
  EventManager,
  isDefined,
  getBlockForTimestamp,
  getChainQuorum,
  getCurrentTime,
  getDeploymentBlockNumber,
  getNetworkName,
  getNodeUrlList,
  getOriginFromURL,
  getSvmProvider,
  Logger,
  winston,
} from "../utils";
import { getRedisCache } from "../cache/Redis";
import { ScraperOpts } from "./types";
import { bootstrap } from "./util/bootstrap";
import { postBlock, postEvents } from "./util/ipc";
import { scrapeEvents as _scrapeEvents } from "./util/svm";

type WSProvider = RpcSubscriptions<SolanaRpcSubscriptionsApi>;
type EventWithData = arch.svm.EventWithData;

const abortController = new AbortController();

const PROGRAM = "RelayerSpokePoolListenerSVM";
let logger: winston.Logger;
let chainId: number;
let chain: string;

// These are Log fields that are irrelevant for SVM and are only needed for the messaging interface.
// These will ultimately be dropped from the messaging interface.
const UNUSED_FIELDS = {
  blockHash: "",
  transactionIndex: 0,
  logIndex: 0,
  data: "",
  topics: Array<string>(),
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
 * Aggregate utils/scrapeEvents for a series of event names and submit them to the parent process.
 * @param eventsClient SVM CPI events client instance.
 * @param eventNames The array of events to be queried.
 * @param opts Options to configure event scraping behaviour, including the target block number.
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
    if (!postBlock(Number(opts.to), currentTime) || !postEvents(events.flat().map(logFromEvent))) {
      abortController.abort();
    }
  }
}

/**
 * Given a SpokePool eventsClient instance and an array of event names, subscribe to all future event emissions.
 * Periodically transmit received events to the parent process (if defined).
 * @param eventMgr Event manager instance.
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
  const at = "RelayerSpokePoolListenerSVM::listen";

  const urls = Object.values(getNodeUrlList(chainId, quorum, "wss"));
  const nProviders = urls.length;
  assert(nProviders >= quorum, `Insufficient providers for ${chain} (required ${quorum} by quorum)`);

  const eventAuthority = await arch.svm.getEventAuthority(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS);
  const config = { commitment: "confirmed" } as const;
  const { signal: abortSignal } = abortController;

  // Default keepalive interval is 5s but this can cause premature hangup.
  // See https://github.com/anza-xyz/agave/issues/7022
  const intervalMs = Number(process.env.RELAYER_SVM_WS_KEEPALIVE ?? 10) * 1000;
  const providers = urls.map((url) => createSolanaRpcSubscriptions(url, { intervalMs }));

  // Solana hosted WS providers periodically drop subscriptions without sending a close frame (code 1006).
  // Chainstack does this on a deterministic ~10-minute wallclock schedule; Alchemy does it less predictably.
  // Reconnect on close with bounded exponential backoff rather than aborting the whole listener.
  const RECONNECT_BACKOFF_MIN_S = 1;
  const RECONNECT_BACKOFF_MAX_S = 30;

  // CloseEvent exposes code/wasClean/reason as prototype getters, so winston serializes
  // the cause as {} (or "[object CloseEvent]") and drops the only useful fields. Project
  // them onto own properties before logging.
  const extractCloseEventSignal = (cause: unknown): { code?: number; wasClean?: boolean; reason?: string } => {
    if (cause === null || typeof cause !== "object") {
      return {};
    }
    const { code, wasClean, reason } = cause as {
      code?: unknown;
      wasClean?: unknown;
      reason?: unknown;
    };
    return {
      code: typeof code === "number" ? code : undefined,
      wasClean: typeof wasClean === "boolean" ? wasClean : undefined,
      reason: typeof reason === "string" ? reason : undefined,
    };
  };

  const logProviderError = (providerName: string, err: unknown, backoffS: number) => {
    const message = "Caught error on Solana provider; reconnecting.";
    const baseCtx = { at, message, provider: providerName, backoffS };
    if (arch.svm.isSolanaError(err)) {
      const { code, wasClean, reason } = extractCloseEventSignal(err.cause);
      const ctx = { ...baseCtx, code, wasClean, reason };
      // 1006 with no close frame is the documented Chainstack shared-gateway rotation
      // (https://docs.chainstack.com/docs/error-reference); demote to debug. Anything
      // else (e.g. 1011 Internal Error from Alchemy, unknown codes) stays at warn.
      if (code === 1006 && wasClean === false) {
        logger.debug(ctx);
      } else {
        logger.warn(ctx);
      }
    } else {
      const cause = typeguards.isError(err) ? err.message : "unknown cause";
      logger.warn({ ...baseCtx, cause });
    }
  };

  const readSlot = async (provider: WSProvider, providerName: string) => {
    let backoffS = RECONNECT_BACKOFF_MIN_S;
    while (!abortSignal.aborted) {
      try {
        const subscription = await provider.slotNotifications().subscribe({ abortSignal });
        for await (const { slot } of subscription) {
          backoffS = RECONNECT_BACKOFF_MIN_S; // reset on any successful update
          const currentTime = getCurrentTime(); // @todo Try to subscribe w/ timestamp updates.

          if (!postBlock(Number(slot), currentTime)) {
            abortController.abort();
          }
        }
        // Iterator returned cleanly (abortSignal cancelled the subscription).
        return;
      } catch (err: unknown) {
        if (abortSignal.aborted) {
          return;
        }
        logProviderError(providerName, err, backoffS);
        await abortableDelay(backoffS, abortSignal);
        backoffS = Math.min(backoffS * 2, RECONNECT_BACKOFF_MAX_S);
      }
    }
  };

  const readEvent = async (provider: WSProvider, providerName: string) => {
    let backoffS = RECONNECT_BACKOFF_MIN_S;
    while (!abortSignal.aborted) {
      try {
        const subscription = await provider
          .logsNotifications({ mentions: [address(eventAuthority)] }, config)
          .subscribe({ abortSignal });
        for await (const log of subscription) {
          backoffS = RECONNECT_BACKOFF_MIN_S;
          const { signature } = log.value;
          const rawEvents = await eventsClient.readEventsFromSignature(signature, "confirmed");

          const events = rawEvents
            .filter(({ name }) => eventNames.includes(name))
            .map((event) => logFromEvent({ ...event, signature, slot: log.context.slot }));

          const quorumEvents = events.filter((event) => eventMgr.add(event, providerName));
          if (quorumEvents.length > 0 && !postEvents(quorumEvents)) {
            abortController.abort();
          }
        }
        return;
      } catch (err: unknown) {
        if (abortSignal.aborted) {
          return;
        }
        logProviderError(providerName, err, backoffS);
        await abortableDelay(backoffS, abortSignal);
        backoffS = Math.min(backoffS * 2, RECONNECT_BACKOFF_MAX_S);
      }
    }
  };

  const providerNames = urls.map(getOriginFromURL);
  await Promise.all([
    readSlot(providers[0], providerNames[0]),
    ...providers.map((provider, i) => readEvent(provider, providerNames[i])),
  ]);
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

  chain = getNetworkName(chainId);

  const provider = getSvmProvider(await getRedisCache());
  const blockFinder: undefined = undefined;
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
    logger.debug({ at, message: `Skipping lookback on ${chain}.` });
  }

  const opts = {
    quorum,
    deploymentBlock,
    lookback: Number(latestSlot - startSlot),
  };

  logger.debug({ at, message: `Starting ${chain} SpokePool Indexer.`, opts });

  const eventsClient = await arch.svm.SvmCpiEventsClient.create(getSvmProvider());
  if (latestSlot > startSlot) {
    const events = ["FundsDeposited", "FilledRelay", "RelayedRootBundle", "ExecutedRelayerRefundRoot"];
    await scrapeEvents(eventsClient, events, { ...opts, to: latestSlot });
  }

  const events = ["FundsDeposited", "FilledRelay"];
  logger.debug({ at, message: `Starting ${chain} listener.`, events, opts });
  const eventMgr = new EventManager(logger, chainId, quorum);

  await listen(eventMgr, eventsClient, events, quorum);
}

if (require.main === module) {
  logger = Logger;
  bootstrap({ program: PROGRAM, abortController, chainName: () => chain, run });
}

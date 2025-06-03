import assert from "assert";
import { arch } from "@across-protocol/sdk";
import { Profiler, winston } from "../../../utils";
import { ScraperOpts } from "../../types";

/**
 * Given a SpokePool contract instance and an event name, scrape all corresponding events and submit them to the
 * parent process (if defined).
 * @param spokePool Ethers Contract instance.
 * @param eventName The name of the event to be filtered.
 * @param opts Options to configure event scraping behaviour.
 * @returns void
 */
export async function scrapeEvents(
  chain: string,
  eventsClient: arch.svm.SvmCpiEventsClient,
  eventName: string,
  opts: ScraperOpts & { to: bigint },
  logger: winston.Logger
): Promise<arch.svm.EventWithData[]> {
  const { lookback, deploymentBlock, to } = opts;

  const from = Math.max(Number(to) - (lookback ?? deploymentBlock), deploymentBlock);
  assert(to > from, `${to} > ${from}`);

  const profiler = new Profiler({
    logger,
    at: "scrapeEvents",
  });
  const mark = profiler.start("paginatedEventQuery");
  const events = await eventsClient.queryEvents(arch.svm.getEventName(eventName), BigInt(from), to);

  mark.stop({
    message: `Scraped ${events.length} ${chain} ${eventName} events.`,
    numEvents: events.length,
    chain,
    eventName,
    searchConfig: { from, to },
  });

  return events;
}

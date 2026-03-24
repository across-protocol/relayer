import assert from "assert";
import { arch } from "@across-protocol/sdk";
import { Profiler, winston } from "../../../utils";
import { ScraperOpts } from "../../types";

/**
 * Scrape events from a SVM CPI events client for a given event name within a specified block range.
 * @param chain Chain name identifier.
 * @param eventsClient SVM CPI events client instance.
 * @param eventName The name of the event to be filtered.
 * @param opts Options to configure event scraping behaviour, including the target block number.
 * @param logger Winston logger instance.
 * @returns Promise resolving to an array of events with data.
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

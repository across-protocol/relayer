import assert from "assert";
import { Contract, EventFilter } from "ethers";
import { getNetworkName, isDefined, paginatedEventQuery, Profiler, winston } from "../../../utils";
import { Log, ScraperOpts } from "../../types";

/**
 * Given an event name and contract, return the corresponding Ethers EventFilter object.
 * @param contract Ethers Constract instance.
 * @param eventName The name of the event to be filtered.
 * @param filterArgs Optional filter arguments to be applied.
 * @returns An Ethers EventFilter instance.
 */
export function getEventFilter(contract: Contract, eventName: string, filterArgs?: string[]): EventFilter {
  const filter = contract.filters[eventName];
  if (!isDefined(filter)) {
    throw new Error(`Event ${eventName} not defined for contract`);
  }

  return isDefined(filterArgs) ? filter(...filterArgs) : filter();
}

/**
 * Get a general event filter mapping to be used for filtering SpokePool contract events.
 * This is currently only useful for filtering the relayer address on FilledRelay events.
 * @param relayer Optional relayer address to filter on.
 * @returns An argument array for input to an Ethers EventFilter.
 */
export function getEventFilterArgs(relayer?: string): { [event: string]: (null | string)[] } {
  const FilledRelay = !isDefined(relayer)
    ? undefined
    : [null, null, null, null, null, null, null, null, null, null, relayer];

  return { FilledRelay };
}

/**
 * Given a SpokePool contract instance and an event name, scrape all corresponding events and submit them to the
 * parent process (if defined).
 * @param spokePool Ethers Constract instance.
 * @param eventName The name of the event to be filtered.
 * @param opts Options to configure event scraping behaviour.
 * @returns void
 */
export async function scrapeEvents(
  spokePool: Contract,
  eventName: string,
  opts: ScraperOpts & { toBlock: number },
  logger?: winston.Logger
): Promise<Log[]> {
  const profiler = new Profiler({
    logger,
    at: "scrapeEvents",
  });
  const { lookback, deploymentBlock, filterArgs, maxBlockRange, toBlock } = opts;
  const { chainId } = await spokePool.provider.getNetwork();
  const chain = getNetworkName(chainId);

  const fromBlock = Math.max(toBlock - (lookback ?? deploymentBlock), deploymentBlock);
  assert(toBlock > fromBlock, `${toBlock} > ${fromBlock}`);
  const searchConfig = { fromBlock, toBlock, maxBlockLookBack: maxBlockRange };

  const mark = profiler.start("paginatedEventQuery");
  const filter = getEventFilter(spokePool, eventName, filterArgs[eventName]);
  const events = await paginatedEventQuery(spokePool, filter, searchConfig);
  mark.stop({
    message: `Scraped ${events.length} ${chain} ${eventName} events.`,
    numEvents: events.length,
    chain,
    eventName,
    searchConfig,
  });

  return events;
}

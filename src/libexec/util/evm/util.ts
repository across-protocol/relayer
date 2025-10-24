import assert from "assert";
import { Contract, utils as ethersUtils } from "ethers";
import { getNetworkName, paginatedEventQuery, Profiler, Provider, winston } from "../../../utils";
import { Log, ScraperOpts } from "../../types";

/**
 * Given a SpokePool contract instance and an event name, scrape all corresponding events and submit them to the
 * parent process (if defined).
 * @param provider Ethers RPC provider instance.
 * @param address Contract address to filter on.
 * @param event The event descriptor to filter for.
 * @param opts Options to configure event scraping behaviour.
 * @returns void
 */
export async function scrapeEvents(
  provider: Provider,
  address: string,
  event: string,
  opts: ScraperOpts & { toBlock: number },
  logger?: winston.Logger
): Promise<Log[]> {
  const profiler = new Profiler({
    logger,
    at: "scrapeEvents",
  });
  const { lookback, deploymentBlock, maxBlockRange, toBlock } = opts;
  const { chainId } = await provider.getNetwork();
  const chain = getNetworkName(chainId);

  const fromBlock = Math.max(toBlock - (lookback ?? deploymentBlock), deploymentBlock);
  assert(toBlock > fromBlock, `${toBlock} > ${fromBlock}`);
  const searchConfig = { from: fromBlock, to: toBlock, maxLookBack: maxBlockRange };

  const eventFrag = ethersUtils.Fragment.from(event);
  assert(ethersUtils.EventFragment.isEventFragment(eventFrag), `Invalid event descriptor (${event})`);

  const abi = new ethersUtils.Interface([event]);
  const contract = new Contract(address, abi);
  const [filter] = Object.values(contract.filters);

  const mark = profiler.start("paginatedEventQuery");
  const events = await paginatedEventQuery(contract.connect(provider), filter(), searchConfig);
  mark.stop({
    message: `Scraped ${events.length} ${chain} ${eventFrag.name} events.`,
    searchConfig,
  });

  return events;
}

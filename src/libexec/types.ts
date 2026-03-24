export { Log } from "../interfaces";

export type ScraperOpts = {
  lookback?: number; // Event lookback (in seconds).
  deploymentBlock: number; // SpokePool deployment block
  maxBlockRange?: number; // Maximum block range for paginated getLogs queries.
  filterArgs?: { [event: string]: string[] }; // Event-specific filter criteria to apply.
};

type BlockUpdate = {
  blockNumber: number;
  currentTime: number;
};

type EventRemoved = {
  event: string;
};

type EventsAdded = {
  nEvents: number; // Number of events.
  data: string;
};

export type ListenerMessage = BlockUpdate | EventsAdded | EventRemoved;

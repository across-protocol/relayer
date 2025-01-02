export { Log } from "../interfaces";
export { SpokePoolClientMessage } from "../clients";

export type ScraperOpts = {
  lookback?: number; // Event lookback (in seconds).
  deploymentBlock: number; // SpokePool deployment block
  maxBlockRange?: number; // Maximum block range for paginated getLogs queries.
  filterArgs?: { [event: string]: string[] }; // Event-specific filter criteria to apply.
};

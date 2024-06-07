import { utils } from "@across-protocol/sdk";
import { Fill, SlowFillRequest } from "../interfaces";
import { SpokePoolClient } from "../clients";
import { getRedisCache } from "./";

// Load a deposit for a fill if the fill's deposit ID is outside this client's search range.
// This can be used by the Dataworker to determine whether to give a relayer a refund for a fill
// of a deposit older or younger than its fixed lookback.
export async function queryHistoricalDepositForFill(
  spokePoolClient: SpokePoolClient,
  fill: Fill | SlowFillRequest
): Promise<utils.DepositSearchResult> {
  return utils.queryHistoricalDepositForFill(spokePoolClient, fill, await getRedisCache(spokePoolClient.logger));
}

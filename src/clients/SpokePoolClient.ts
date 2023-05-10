import {
  getDeposit,
  setDeposit,
  getNetworkName,
  getRedisDepositKey,
  assert,
  validateFillForDeposit,
  getCurrentTime,
  getRedis,
} from "../utils";
import { paginatedEventQuery, spreadEventWithBlockNumber } from "../utils";
import { Deposit, DepositWithBlock, Fill, FundsDepositedEvent } from "../interfaces";
import { clients } from "@across-protocol/sdk-v2";

export class SpokePoolClient extends clients.SpokePoolClient {
  // Load a deposit for a fill if the fill's deposit ID is outside this client's search range.
  // This can be used by the Dataworker to determine whether to give a relayer a refund for a fill
  // of a deposit older or younger than its fixed lookback.
  async queryHistoricalDepositForFill(fill: Fill): Promise<DepositWithBlock | undefined> {
    const start = Date.now();
    if (fill.originChainId !== this.chainId) {
      throw new Error("fill.originChainId !== this.chainid");
    }

    // We need to update client so we know the first and last deposit ID's queried for this spoke pool client, as well
    // as the global first and last deposit ID's for this spoke pool.
    if (!this.isUpdated) {
      throw new Error("SpokePoolClient must be updated before querying historical deposits");
    }
    if (fill.depositId < this.firstDepositIdForSpokePool || fill.depositId > this.lastDepositIdForSpokePool) {
      return undefined;
    }
    if (fill.depositId >= this.earliestDepositIdQueried && fill.depositId <= this.latestDepositIdQueried) {
      return this.getDepositForFill(fill);
    }

    let deposit: DepositWithBlock, cachedDeposit: Deposit | undefined;
    const redisClient = await getRedis(this.logger);
    if (redisClient) {
      cachedDeposit = await getDeposit(getRedisDepositKey(fill), redisClient);
    }
    if (cachedDeposit) {
      deposit = cachedDeposit as DepositWithBlock;
      // Assert that cache hasn't been corrupted.
      assert(deposit.depositId === fill.depositId && deposit.originChainId === fill.originChainId);
    } else {
      // Binary search for block where SpokePool.numberOfDeposits incremented to fill.depositId + 1.
      // This way we can get the blocks before and after the deposit with deposit ID = fill.depositId
      // and use those blocks to optimize the search for that deposit. Stop searches after a maximum
      // # of searches to limit number of eth_call requests. Make an eth_getLogs call on the remaining block range
      // (i.e. the [low, high] remaining from the binary search) to find the target deposit ID.
      // @dev Limiting between 5-10 searches empirically performs best when there are ~300,000 deposits
      // for a spoke pool and we're looking for a deposit <5 days older than HEAD.
      const searchBounds = await this._getBlockRangeForDepositId(
        fill.depositId + 1,
        this.deploymentBlock,
        this.latestBlockNumber,
        7
      );
      const query = await paginatedEventQuery(
        this.spokePool,
        this.spokePool.filters.FundsDeposited(
          null,
          null,
          fill.destinationChainId,
          null,
          fill.depositId,
          null,
          null,
          null,
          fill.depositor,
          null
        ),
        {
          fromBlock: searchBounds.low,
          toBlock: searchBounds.high,
          maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
        }
      );
      const event = (query as FundsDepositedEvent[]).find((deposit) => deposit.args.depositId === fill.depositId);
      if (event === undefined) {
        const srcChain = getNetworkName(fill.originChainId);
        const dstChain = getNetworkName(fill.destinationChainId);
        throw new Error(
          `Could not find deposit ${fill.depositId} for ${dstChain} fill` +
            ` between ${srcChain} blocks [${searchBounds.low}, ${searchBounds.high}]`
        );
      }
      const partialDeposit = spreadEventWithBlockNumber(event) as DepositWithBlock;
      const { realizedLpFeePct, quoteBlock: quoteBlockNumber } = await this.computeRealizedLpFeePct(event); // Append the realizedLpFeePct.
      // Append destination token and realized lp fee to deposit.
      deposit = {
        ...partialDeposit,
        realizedLpFeePct,
        destinationToken: this.getDestinationTokenForDeposit(partialDeposit),
        quoteBlockNumber,
      };
      this.logger.debug({
        at: "SpokePoolClient#queryHistoricalDepositForFill",
        message: "Queried RPC for deposit outside SpokePoolClient's search range",
        deposit,
        elapsedMs: Date.now() - start,
      });
      if (redisClient) {
        await setDeposit(deposit, getCurrentTime(), redisClient, 24 * 60 * 60);
      }
    }

    return validateFillForDeposit(fill, deposit) ? deposit : undefined;
  }
}

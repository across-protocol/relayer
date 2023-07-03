import { clients } from "@across-protocol/sdk-v2";
import { DepositWithBlock, FundsDepositedEvent } from "../interfaces";
import { getNetworkName, paginatedEventQuery, spreadEventWithBlockNumber } from "../utils";

export class SpokePoolClient extends clients.SpokePoolClient {
  getCurrentTime(): number {
    return this.currentTime;
  }

  async findDeposit(depositId: number, destinationChainId: number, depositor: string): Promise<DepositWithBlock> {
    // Binary search for block where SpokePool.numberOfDeposits incremented to fill.depositId + 1.
    // This way we can get the blocks before and after the deposit with deposit ID = fill.depositId
    // and use those blocks to optimize the search for that deposit. Stop searches after a maximum
    // # of searches to limit number of eth_call requests. Make an eth_getLogs call on the remaining block range
    // (i.e. the [low, high] remaining from the binary search) to find the target deposit ID.
    // @dev Limiting between 5-10 searches empirically performs best when there are ~300,000 deposits
    // for a spoke pool and we're looking for a deposit <5 days older than HEAD.
    const searchBounds = await this._getBlockRangeForDepositId(
      depositId + 1,
      this.deploymentBlock,
      this.latestBlockNumber,
      7
    );

    const tStart = Date.now();
    const query = await paginatedEventQuery(
      this.spokePool,
      this.spokePool.filters.FundsDeposited(
        null,
        null,
        destinationChainId,
        null,
        depositId,
        null,
        null,
        null,
        depositor,
        null
      ),
      {
        fromBlock: searchBounds.low,
        toBlock: searchBounds.high,
        maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
      }
    );
    const tStop = Date.now();

    const event = (query as FundsDepositedEvent[]).find((deposit) => deposit.args.depositId === depositId);
    if (event === undefined) {
      const srcChain = getNetworkName(this.chainId);
      const dstChain = getNetworkName(destinationChainId);
      throw new Error(
        `Could not find deposit ${depositId} for ${dstChain} fill` +
          ` between ${srcChain} blocks [${searchBounds.low}, ${searchBounds.high}]`
      );
    }
    const partialDeposit = spreadEventWithBlockNumber(event) as DepositWithBlock;
    const { realizedLpFeePct, quoteBlock: quoteBlockNumber } = await this.computeRealizedLpFeePct(event); // Append the realizedLpFeePct.

    // Append destination token and realized lp fee to deposit.
    const deposit: DepositWithBlock = {
      ...partialDeposit,
      realizedLpFeePct,
      destinationToken: this.getDestinationTokenForDeposit(partialDeposit),
      quoteBlockNumber,
    };

    this.logger.debug({
      at: "SpokePoolClient#findDeposit",
      message: "Located deposit outside of SpokePoolClient's search range",
      deposit,
      elapsedMs: tStop - tStart,
    });

    return deposit;
  }
}

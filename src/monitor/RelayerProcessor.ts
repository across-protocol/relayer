import { SpokePool } from "@across-protocol/contracts-v2";
import { ethers } from "ethers";
import { winston } from "../utils";

export interface RelayedDeposit {
  logIndex: number;
  blockNumber: number;
  transactionHash: string;
  relayer: string;
  action: string;
}

export class RelayerProcessor {
  private eventActions: { [key: string]: string } = {
    FilledRelay: "refund root executed",
  };

  // eslint-disable-next-line no-useless-constructor
  constructor(private readonly logger: winston.Logger) {}

  async getRelayedEventsInfo(
    spokePool: SpokePool,
    startingBlock: number | undefined,
    endingBlock: number | undefined
  ): Promise<RelayedDeposit[]> {
    const eventsInfo: RelayedDeposit[] = [];

    if (startingBlock > endingBlock) {
      return;
    }

    const executedRelayerRefundEvents = await spokePool.queryFilter(
      spokePool.filters.FilledRelay(),
      startingBlock,
      endingBlock
    );

    for (const event of executedRelayerRefundEvents) {
      let relayer: string;

      switch (event.event) {
        case "FilledRelay":
          relayer = event.args.relayer;
          break;
        default:
          this.logger.error(`[FilledRelay] unhandled event ${event.event}`);
          break;
      }

      relayer = ethers.utils.getAddress(relayer);
      const RelayedDeposit: RelayedDeposit = {
        blockNumber: event.blockNumber,
        logIndex: event.logIndex,
        transactionHash: event.transactionHash,
        relayer,
        action: this.eventActions[event.event],
      };
      eventsInfo.push(RelayedDeposit);
    }

    // Primary sort on block number. Secondary sort on logIndex.
    eventsInfo.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber - b.blockNumber;
      }

      return a.logIndex - b.logIndex;
    });

    return eventsInfo;
  }
}

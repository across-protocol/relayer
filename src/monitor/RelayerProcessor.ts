import { SpokePool } from "@across-protocol/contracts-v2";
import { ethers } from "ethers";
import { winston } from "../utils";

export interface EventInfo {
  logIndex: number;
  blockNumber: number;
  transactionHash: string;
  caller: string;
  action: string;
  rootBundleId: number;
}

export class RelayerProcessor {
  private eventActions: { [key: string]: string } = {
    ExecutedRelayerRefundRoot: "refund root executed",
  };

  // eslint-disable-next-line no-useless-constructor
  constructor(private readonly logger: winston.Logger) {}

  async getRelayedEventsInfo(
    spokePool: SpokePool,
    startingBlock: number | undefined,
    endingBlock: number | undefined
  ): Promise<EventInfo[]> {
    const eventsInfo: EventInfo[] = [];

    if (startingBlock > endingBlock) {
      return;
    }

    const executedRelayerRefundEvents = await spokePool.queryFilter(
      spokePool.filters.ExecutedRelayerRefundRoot(),
      startingBlock,
      endingBlock
    );

    for (const event of executedRelayerRefundEvents) {
      let caller: string;

      switch (event.event) {
        case "ExecutedRelayerRefundRootEvent":
          caller = event.args.caller;
          break;
        default:
          this.logger.error(`[getRelayedEventsInfo] unhandled event ${event.event}`);
          break;
      }

      caller = ethers.utils.getAddress(caller);
      const eventInfo: EventInfo = {
        blockNumber: event.blockNumber,
        logIndex: event.logIndex,
        transactionHash: event.transactionHash,
        caller,
        action: this.eventActions[event.event],
        rootBundleId: event.args.rootBundleId,
      };
      eventsInfo.push(eventInfo);
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

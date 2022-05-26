import {
  ProposeRootBundleEvent,
  RootBundleExecutedEvent,
  RootBundleDisputedEvent,
  RootBundleCanceledEvent,
} from "@across-protocol/contracts-v2/dist/typechain/HubPool";
import { ethers } from "ethers";
import { HubPoolClient } from "../clients";
import { winston } from "../utils";

export interface EventInfo {
  logIndex: number;
  blockNumber: number;
  transactionHash: string;
  caller: string;
  action: string;
}

export class RootBundleProcessor {
  private eventActions: { [key: string]: string } = {
    ProposeRootBundle: "proposed",
    RootBundleDisputed: "disputed",
    RootBundleCanceled: "canceled",
  };

  constructor(readonly logger: winston.Logger, readonly hubPoolClient: HubPoolClient) {}

  async getRootBundleEventsInfo(
    startingBlock: number | undefined,
    endingBlock: number | undefined
  ): Promise<EventInfo[]> {
    const eventsInfo: EventInfo[] = [];

    if (startingBlock > endingBlock) {
      return;
    }

    const [proposeRootBundleEvents, rootBundleDisputedEvents, rootBundleCanceledEvents] = await Promise.all([
      this.hubPoolClient.hubPool.queryFilter(
        this.hubPoolClient.hubPool.filters.ProposeRootBundle(),
        startingBlock,
        endingBlock
      ),
      this.hubPoolClient.hubPool.queryFilter(
        this.hubPoolClient.hubPool.filters.RootBundleDisputed(),
        startingBlock,
        endingBlock
      ),
      this.hubPoolClient.hubPool.queryFilter(
        this.hubPoolClient.hubPool.filters.RootBundleCanceled(),
        startingBlock,
        endingBlock
      ),
    ]);
    const allEvents = proposeRootBundleEvents.concat(rootBundleDisputedEvents).concat(rootBundleCanceledEvents);

    for (const event of allEvents) {
      let caller: string;

      switch (event.event) {
        case "ProposeRootBundle":
          caller = (event as ProposeRootBundleEvent).args.proposer;
          break;
        case "RootBundleDisputed":
          caller = (event as RootBundleDisputedEvent).args.disputer;
          break;
        case "RootBundleCanceled":
          caller = (event as RootBundleCanceledEvent).args.disputer;
          break;
        default:
          this.logger.error(`[rootBundleEventsInfo] unhandled event ${event.event}`);
          break;
      }

      caller = ethers.utils.getAddress(caller);
      const eventInfo: EventInfo = {
        blockNumber: event.blockNumber,
        logIndex: event.logIndex,
        transactionHash: event.transactionHash,
        caller,
        action: this.eventActions[event.event],
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

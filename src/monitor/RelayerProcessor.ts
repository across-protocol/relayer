import { SpokePool } from "@across-protocol/contracts-v2";
import { ethers } from "ethers";
import { winston } from "../utils";

export interface EventInfo {
  logIndex: number;
  blockNumber: number;
  transactionHash: string;
  caller: string;
  action: string;
  slowRelayRoot: string;
  relayerRefundRoot: string;
  rootBundleId: number;
}

export class RelayerProcessor {
  private eventActions: { [key: string]: string } = {
    RelayedRootBundleEvent: "relayed",
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

    const relayedRootBundleEvents = await spokePool.queryFilter(
      spokePool.filters.RelayedRootBundle(),
      startingBlock,
      endingBlock
    );

    for (const event of relayedRootBundleEvents) {
      let caller: string;

      switch (event.event) {
        case "RelayedRootBundleEvent":
          caller = "TODO";
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
        slowRelayRoot: event.args.slowRelayRoot,
        relayerRefundRoot: event.args.relayerRefundRoot,
        rootBundleId: event.args.rootBundleId,
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

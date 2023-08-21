import { Contract, BigNumber, Event, EventSearchConfig } from "../../../utils";

export interface BridgeTransactionDetails {
  readonly contract: Contract;
  readonly method: string;
  readonly args: any[];
}

export interface OpStackBridge {
  readonly l1Gateway: string;
  constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber,
    l2Gas: number
  ): BridgeTransactionDetails;
  queryL1BridgeInitiationEvents(l1Token: string, fromAddress: string, eventConfig: EventSearchConfig): Promise<Event[]>;
  queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<Event[]>;
}

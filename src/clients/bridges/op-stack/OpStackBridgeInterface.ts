import { Contract, BigNumber, Event, EventSearchConfig } from "../../../utils";

export interface BridgeTransactionDetails {
  readonly contract: Contract;
  readonly method: string;
  readonly args: unknown[];
}

export interface OpStackBridge {
  readonly l1Gateways: string[];
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

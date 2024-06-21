import { Contract, BigNumber, EventSearchConfig, Signer, Provider, getTokenAddressWithCCTP } from "../../utils";
import { SortableEvent } from "../../interfaces";

export interface BridgeTransactionDetails {
  readonly contract: Contract;
  readonly method: string;
  readonly args: unknown[];
  readonly value?: BigNumber;
}

export type BridgeEvent = SortableEvent & {
  to: string;
  from: string;
  amount: BigNumber;
};

export type BridgeEvents = { [l2Token: string]: BridgeEvent[] };

export abstract class BaseBridgeAdapter {
  constructor(
    protected l2chainId: number,
    protected hubChainId: number,
    protected l1Signer: Signer,
    protected l2SignerOrProvider: Signer | Provider,
    readonly l1Gateways: string[]
  ) {}

  abstract constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails>;

  abstract queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents>;

  abstract queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents>;

  protected resolveL2TokenAddress(l1Token: string): string {
    return getTokenAddressWithCCTP(l1Token, this.hubChainId, this.l2chainId, false);
  }
}

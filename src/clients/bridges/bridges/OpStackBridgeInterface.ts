import {
  Contract,
  BigNumber,
  Event,
  EventSearchConfig,
  Signer,
  Provider,
  getTokenAddressWithCCTP,
} from "../../../utils";

export interface BridgeTransactionDetails {
  readonly contract: Contract;
  readonly method: string;
  readonly args: unknown[];
}

export type OpStackEvents = { [l2Token: string]: Event[] };

export abstract class OpStackBridge {
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
    amount: BigNumber,
    l2Gas: number
  ): BridgeTransactionDetails;

  abstract queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<OpStackEvents>;

  abstract queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<OpStackEvents>;

  protected resolveL2TokenAddress(l1Token: string): string {
    return getTokenAddressWithCCTP(l1Token, this.hubChainId, this.l2chainId, false);
  }
}

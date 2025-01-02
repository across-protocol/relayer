import {
  Contract,
  BigNumber,
  EventSearchConfig,
  Signer,
  Provider,
  getTranslatedTokenAddress,
  assert,
  isDefined,
} from "../../utils";
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
  protected l1Bridge: Contract;
  protected l2Bridge: Contract;
  public gasToken: string | undefined;

  constructor(
    protected l2chainId: number,
    protected hubChainId: number,
    protected l1Signer: Signer,
    protected l2SignerOrProvider: Signer | Provider,
    public l1Gateways: string[]
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
    return getTranslatedTokenAddress(l1Token, this.hubChainId, this.l2chainId, false);
  }

  protected getL1Bridge(): Contract {
    assert(isDefined(this.l1Bridge), "Cannot access L1 Bridge when it is undefined.");
    return this.l1Bridge;
  }

  protected getL2Bridge(): Contract {
    assert(isDefined(this.l2Bridge), "Cannot access L2 Bridge when it is undefined.");
    return this.l2Bridge;
  }
}

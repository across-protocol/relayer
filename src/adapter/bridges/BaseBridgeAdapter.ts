import {
  Contract,
  BigNumber,
  EventSearchConfig,
  Signer,
  Provider,
  getTranslatedTokenAddress,
  assert,
  isDefined,
  EvmAddress,
  Address,
} from "../../utils";
import { SortableEvent } from "../../interfaces";

export interface BridgeTransactionDetails {
  readonly contract: Contract;
  readonly method: string;
  readonly args: unknown[];
  readonly value?: BigNumber;
}

export type BridgeEvent = SortableEvent & {
  amount: BigNumber;
};

export type BridgeEvents = { [l2Token: string]: BridgeEvent[] };

export abstract class BaseBridgeAdapter {
  protected l1Bridge: Contract;
  protected l2Bridge: Contract;
  public gasToken: EvmAddress | undefined;

  constructor(
    protected l2chainId: number,
    protected hubChainId: number,
    protected l1Signer: Signer,
    protected l2SignerOrProvider: Signer | Provider,
    public l1Gateways: EvmAddress[]
  ) {}

  abstract constructL1ToL2Txn(
    toAddress: Address,
    l1Token: EvmAddress,
    l2Token: Address,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails>;

  abstract queryL1BridgeInitiationEvents(
    l1Token: EvmAddress,
    fromAddress: Address,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents>;

  abstract queryL2BridgeFinalizationEvents(
    l1Token: EvmAddress,
    fromAddress: Address,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents>;

  protected resolveL2TokenAddress(l1Token: EvmAddress): string {
    return getTranslatedTokenAddress(l1Token.toAddress(), this.hubChainId, this.l2chainId, false);
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

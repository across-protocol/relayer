import {
  Contract,
  BigNumber,
  EventSearchConfig,
  getTranslatedTokenAddress,
  assert,
  isDefined,
  EvmAddress,
  Address,
  getHubPoolAddress,
  getSpokePoolAddress,
} from "../utils";
import { SortableEvent } from "../interfaces";
import { TransferTokenParams } from "./utils";

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

export abstract class BaseBridgeAdapter<O, D> {
  protected l1Bridge: Contract;
  protected l2Bridge: Contract;
  public gasToken: EvmAddress | undefined;
  protected readonly hubPoolAddress: EvmAddress;
  protected readonly spokePoolAddress: Address;

  constructor(
    protected dstChainId: number,
    protected srcChainId: number,
    protected srcSigner: O,
    protected dstSignerOrProvider: D,
    public srcGateways: EvmAddress[]
  ) {
    this.hubPoolAddress = getHubPoolAddress(srcChainId);
    this.spokePoolAddress = getSpokePoolAddress(dstChainId);
  }

  abstract constructL1ToL2Txn(
    toAddress: Address,
    l1Token: EvmAddress,
    l2Token: Address,
    amount: BigNumber,
    optionalParams?: TransferTokenParams
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
    return getTranslatedTokenAddress(l1Token, this.srcChainId, this.dstChainId, false).toNative();
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

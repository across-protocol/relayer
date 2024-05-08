import {
  Contract,
  BigNumber,
  paginatedEventQuery,
  Event,
  EventSearchConfig,
  Signer,
  Provider,
} from "../../../../utils";
import { CONTRACT_ADDRESSES } from "../../../../common";
import { OpStackBridge, BridgeTransactionDetails } from "../OpStackBridgeInterface";

export class SnxOptimismBridge implements OpStackBridge {
  private readonly l1Bridge: Contract;
  private readonly l2Bridge: Contract;

  constructor(private l2chainId: number, hubChainId: number, l1Signer: Signer, l2SignerOrProvider: Signer | Provider) {
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].snxOptimismBridge;
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);

    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].snxOptimismBridge;
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);
  }

  get l1Gateways(): string[] {
    return [this.l1Bridge.address];
  }

  constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    l2Gas: number
  ): BridgeTransactionDetails {
    return {
      contract: this.l1Bridge,
      method: "depositTo",
      args: [toAddress, amount],
    };
  }

  queryL1BridgeInitiationEvents(l1Token: string, toAddress: string, eventConfig: EventSearchConfig): Promise<Event[]> {
    // @dev For the SnxBridge, only the `toAddress` is indexed on the L2 event so we treat the `fromAddress` as the
    // toAddress when fetching the L1 event.
    return paginatedEventQuery(
      this.l1Bridge,
      this.l1Bridge.filters.DepositInitiated(undefined, toAddress),
      eventConfig
    );
  }

  queryL2BridgeFinalizationEvents(
    l1Token: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<Event[]> {
    return paginatedEventQuery(this.l2Bridge, this.l2Bridge.filters.DepositFinalized(toAddress), eventConfig);
  }
}

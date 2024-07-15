import { Contract, BigNumber, paginatedEventQuery, EventSearchConfig, Signer, Provider } from "../../../../utils";
import { CONTRACT_ADDRESSES } from "../../../../common";
import { OpStackBridge, BridgeTransactionDetails, OpStackEvents } from "../OpStackBridgeInterface";

export class SnxOptimismBridge extends OpStackBridge {
  private readonly l1Bridge: Contract;
  private readonly l2Bridge: Contract;

  constructor(l2chainId: number, hubChainId: number, l1Signer: Signer, l2SignerOrProvider: Signer | Provider) {
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [
      CONTRACT_ADDRESSES[hubChainId].snxOptimismBridge.address,
    ]);

    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].snxOptimismBridge;
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);

    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].snxOptimismBridge;
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);
  }

  protected getL1Bridge(): Contract {
    return this.l1Bridge;
  }

  protected getL2Bridge(): Contract {
    return this.l2Bridge;
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
      contract: this.getL1Bridge(),
      method: "depositTo",
      args: [toAddress, amount],
    };
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<OpStackEvents> {
    const l1Bridge = this.getL1Bridge();
    // @dev For the SnxBridge, only the `toAddress` is indexed on the L2 event so we treat the `fromAddress` as the
    // toAddress when fetching the L1 event.
    return {
      [this.resolveL2TokenAddress(l1Token)]: await paginatedEventQuery(
        l1Bridge,
        l1Bridge.filters.DepositInitiated(undefined, toAddress),
        eventConfig
      ),
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<OpStackEvents> {
    const l2Bridge = this.getL2Bridge();
    return {
      [this.resolveL2TokenAddress(l1Token)]: await paginatedEventQuery(
        l2Bridge,
        l2Bridge.filters.DepositFinalized(toAddress),
        eventConfig
      ),
    };
  }
}

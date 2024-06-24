import { Contract, BigNumber, paginatedEventQuery, EventSearchConfig, Signer, Provider } from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { BaseBridgeAdapter, BridgeTransactionDetails, BridgeEvents } from "./BaseBridgeAdapter";
import { processEvent } from "../utils";

export class SnxOptimismBridge extends BaseBridgeAdapter {
  protected l1Bridge: Contract;
  protected l2Bridge: Contract;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    _l1Token: string
  ) {
    // Lint Appeasement
    _l1Token;
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [
      CONTRACT_ADDRESSES[hubChainId].snxOptimismBridge.address,
    ]);

    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].snxOptimismBridge;
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);

    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].snxOptimismBridge;
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);
  }

  async constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    return Promise.resolve({
      contract: this.l1Bridge,
      method: "depositTo",
      args: [toAddress, amount],
    });
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // @dev For the SnxBridge, only the `toAddress` is indexed on the L2 event so we treat the `fromAddress` as the
    // toAddress when fetching the L1 event.
    const events = await paginatedEventQuery(
      this.l1Bridge,
      this.l1Bridge.filters.DepositInitiated(undefined, fromAddress),
      eventConfig
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "_amount", "_to", "_from")),
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const events = await paginatedEventQuery(
      this.l2Bridge,
      this.l2Bridge.filters.DepositFinalized(fromAddress),
      eventConfig
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "_amount", "_to", "_from")),
    };
  }
}

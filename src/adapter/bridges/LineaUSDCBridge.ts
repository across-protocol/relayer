import { Contract, BigNumber, paginatedEventQuery, Signer, EventSearchConfig, Provider } from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import { processEvent } from "../utils";

export class LineaUSDCBridge extends BaseBridgeAdapter {
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
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].lineaL1UsdcBridge;
    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].lineaL2UsdcBridge;
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [l1Address]);

    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);
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
      args: [amount, toAddress],
    });
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const events = await paginatedEventQuery(
      this.l1Bridge,
      this.l1Bridge.filters.Deposited(undefined, undefined, fromAddress),
      eventConfig
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "amount", "to", "depositor")),
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
      this.l2Bridge.filters.ReceivedFromOtherLayer(fromAddress),
      eventConfig
    );
    // There is no "from" address in this event.
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) =>
        processEvent(event, "amount", "recipient", "recipient")
      ),
    };
  }
}

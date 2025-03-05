import { Contract, BigNumber, paginatedEventQuery, Signer, EventSearchConfig, Provider, EvmAddress } from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import { processEvent } from "../utils";

export class LineaUSDCBridge extends BaseBridgeAdapter {
  constructor(l2chainId: number, hubChainId: number, l1Signer: Signer, l2SignerOrProvider: Signer | Provider) {
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].lineaL1UsdcBridge;
    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].lineaL2UsdcBridge;
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [EvmAddress.from(l1Address)]);

    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);
  }

  async constructL1ToL2Txn(
    toAddress: EvmAddress,
    l1Token: EvmAddress,
    l2Token: EvmAddress,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    return Promise.resolve({
      contract: this.getL1Bridge(),
      method: "depositTo",
      args: [amount, toAddress.toAddress()],
    });
  }

  async queryL1BridgeInitiationEvents(
    l1Token: EvmAddress,
    fromAddress: EvmAddress,
    toAddress: EvmAddress,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const events = await paginatedEventQuery(
      this.getL1Bridge(),
      this.getL1Bridge().filters.Deposited(undefined, undefined, toAddress.toAddress()),
      eventConfig
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) =>
        processEvent(event, "amount", "to", "depositor", this.l2chainId)
      ),
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: EvmAddress,
    fromAddress: EvmAddress,
    toAddress: EvmAddress,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const events = await paginatedEventQuery(
      this.getL2Bridge(),
      this.getL2Bridge().filters.ReceivedFromOtherLayer(toAddress.toAddress()),
      eventConfig
    );
    // There is no "from" address in this event.
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) =>
        processEvent(event, "amount", "recipient", "recipient", this.l2chainId)
      ),
    };
  }
}

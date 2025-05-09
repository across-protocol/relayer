import { Contract, BigNumber, paginatedEventQuery, EventSearchConfig, Signer, Provider, EvmAddress } from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { BaseBridgeAdapter, BridgeTransactionDetails, BridgeEvents } from "./BaseBridgeAdapter";
import { processEvent } from "../utils";

export class OpStackUSDCBridge extends BaseBridgeAdapter {
  private readonly l2Gas = 200000;

  constructor(l2chainId: number, hubChainId: number, l1Signer: Signer, l2SignerOrProvider: Signer | Provider) {
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId][`opUSDCBridge_${l2chainId}`];
    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].opUSDCBridge;
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [EvmAddress.from(l1Address)]);

    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);
  }

  async constructL1ToL2Txn(
    toAddress: EvmAddress,
    _l1Token: EvmAddress,
    _l2Token: EvmAddress,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    return Promise.resolve({
      contract: this.getL1Bridge(),
      method: "sendMessage",
      args: [toAddress.toAddress(), amount, this.l2Gas],
    });
  }

  async queryL1BridgeInitiationEvents(
    l1Token: EvmAddress,
    _fromAddress: EvmAddress,
    toAddress: EvmAddress,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const l1Bridge = this.getL1Bridge();
    const events = await paginatedEventQuery(
      l1Bridge,
      l1Bridge.filters.MessageSent(undefined, toAddress.toAddress()),
      eventConfig
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "_amount")),
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: EvmAddress,
    _fromAddress: EvmAddress,
    toAddress: EvmAddress,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const l2Bridge = this.getL2Bridge();
    const events = await paginatedEventQuery(
      l2Bridge,
      l2Bridge.filters.MessageReceived(undefined, toAddress.toAddress()),
      eventConfig
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "_amount")),
    };
  }
}

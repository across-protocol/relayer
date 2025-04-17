import { Contract, BigNumber, paginatedEventQuery, Signer, EventSearchConfig, Provider, EvmAddress } from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import { processEvent } from "../utils";

export class LineaBridge extends BaseBridgeAdapter {
  constructor(l2chainId: number, hubChainId: number, l1Signer: Signer, l2SignerOrProvider: Signer | Provider) {
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].lineaL1TokenBridge;
    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].lineaL2TokenBridge;
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
      method: "bridgeToken",
      args: [l1Token.toAddress(), amount, toAddress.toAddress()],
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
      this.getL1Bridge().filters.BridgingInitiatedV2(undefined, toAddress.toAddress(), l1Token.toAddress()),
      eventConfig
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "amount")),
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
      this.getL2Bridge().filters.BridgingFinalizedV2(l1Token.toAddress(), undefined, undefined, toAddress.toAddress()),
      eventConfig
    );
    // There is no "from" field in this event, so we set it to the L2 token received.
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "amount")),
    };
  }
}

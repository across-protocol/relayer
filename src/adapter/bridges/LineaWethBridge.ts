import {
  Contract,
  BigNumber,
  paginatedEventQuery,
  bnZero,
  Signer,
  EventSearchConfig,
  Provider,
  isDefined,
  assert,
} from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import { processEvent } from "../utils";

export class LineaWethBridge extends BaseBridgeAdapter {
  protected atomicDepositor: Contract;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    _l1Token: string
  ) {
    // Lint Appeasement
    _l1Token;
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].lineaMessageService;
    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].l2MessageService;
    const { address: atomicDepositorAddress, abi: atomicDepositorAbi } = CONTRACT_ADDRESSES[hubChainId].atomicDepositor;
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [atomicDepositorAddress]);

    this.atomicDepositor = new Contract(atomicDepositorAddress, atomicDepositorAbi, l1Signer);
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
      contract: this.atomicDepositor,
      method: "bridgeWethToLinea",
      args: [toAddress, amount],
    });
  }

  // Getting L2 finalization events on Linea is tricky since we need knowledge of the L1 message hash, *and* the L2 event gives no information
  // about the L1 transfer (such as the depositor address or amount), so we need to manually figure this out.
  override async queryL1AndL2BridgeEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    l1SearchConfig: EventSearchConfig,
    l2SearchConfig: EventSearchConfig
  ): Promise<[BridgeEvents, BridgeEvents]> {
    const queryEvents = await this.queryL1BridgeInitiationEvents(l1Token, fromAddress, toAddress, l1SearchConfig);
    const initiatedHashes = Object.values(queryEvents)
      .flat()
      .map((e) => e["_messageHash"])
      .filter((hash) => isDefined(hash));

    const finalizationEvents = await this.queryL2BridgeFinalizationEvents(
      l1Token,
      fromAddress,
      toAddress,
      l2SearchConfig,
      initiatedHashes
    );
    const finalizedHashes = Object.values(finalizationEvents)
      .flat()
      .map((e) => e["_messageHash"])
      .filter((hash) => isDefined(hash));

    // The finalized events are all the query events which have a finalized message hash on L2.
    const finalizedEvents = Object.fromEntries(
      Object.entries(queryEvents).map(([l2Token, events]) => [
        l2Token,
        events.filter((e) => finalizedHashes.includes(e["_messageHash"])),
      ])
    );
    return [queryEvents, finalizedEvents];
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const events = await paginatedEventQuery(
      this.getL1Bridge(),
      this.getL1Bridge().filters.MessageSent(undefined, toAddress),
      eventConfig
    );
    // @dev There will be a MessageSent to the SpokePool address for each RelayedRootBundle so remove
    // those with 0 value.
    return {
      [this.resolveL2TokenAddress(l1Token)]: events
        .map((event) => processEvent(event, "_value", "_to", "_from"))
        .filter(({ amount }) => amount > bnZero),
    };
  }

  // The Linea Weth bridge finalization events contain no information about the amount bridged nor the
  // recipient address. Additionally, the only indexed event is the `messageHash` field, which is obtained
  // by querying the L1 bridge initiation event. Therefore, if we want to calculate outstanding transfers for Linea,
  // we need to first have knowledge of bridge initiation events, then check whether each initiation event
  // has a corresponding finalization event, and finally filter out events from the initiation query which do
  // not have a finalization event and mark it as outstanding.
  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    l2SearchConfig: EventSearchConfig,
    messageHashes?: string[]
  ): Promise<BridgeEvents> {
    assert(isDefined(messageHashes));
    const events = await paginatedEventQuery(
      this.getL2Bridge(),
      this.getL2Bridge().filters.MessageClaimed(messageHashes),
      l2SearchConfig
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "_value", "_to", "_from")),
    };
  }
}

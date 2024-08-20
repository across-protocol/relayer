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
  override async queryL1AndL2BridgeTransferEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    l1SearchConfig: EventSearchConfig,
    l2SearchConfig: EventSearchConfig
  ): Promise<[BridgeEvents, BridgeEvents]> {
    return Promise.all([
      this.queryL1BridgeInitiationEvents(l1Token, fromAddress, toAddress, l1SearchConfig),
      this.queryL2BridgeFinalizationEvents(l1Token, fromAddress, toAddress, l1SearchConfig, l2SearchConfig),
    ]);
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
    return {
      [this.resolveL2TokenAddress(l1Token)]: events
        .map((event) => processEvent(event, "_value", "_to", "_from"))
        .filter(({ amount }) => amount > bnZero),
    };
  }

  // Here, we need knowledge of the l1Search config since otherwise we would have no information about
  // the value and depositor/recipient addresses. This is because the l2 MessageClaimed event contains no
  // information about the amount received nor the recipient.
  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    l1SearchConfig: EventSearchConfig,
    l2SearchConfig?: EventSearchConfig
  ): Promise<BridgeEvents> {
    // @dev L2SearchConfig must be defined for this call. It is only an optional argument so it can conform to the
    // BaseBridgeAdapter class.
    assert(isDefined(l2SearchConfig));
    const initiatedQueryResult = await paginatedEventQuery(
      this.getL1Bridge(),
      this.getL1Bridge().filters.MessageSent(undefined, toAddress),
      l1SearchConfig
    );

    // @dev There will be a MessageSent to the SpokePool address for each RelayedRootBundle so remove
    // those with 0 value.
    const internalMessageHashes = initiatedQueryResult
      .filter(({ args }) => args._value.gt(0))
      .map(({ args }) => args._messageHash);
    const events = await paginatedEventQuery(
      this.getL2Bridge(),
      this.getL2Bridge().filters.MessageClaimed(internalMessageHashes),
      l2SearchConfig
    );
    const finalizedHashes = events.map(({ args }) => args._messageHash);
    return {
      [this.resolveL2TokenAddress(l1Token)]: initiatedQueryResult
        .filter(({ args }) => finalizedHashes.includes(args._messageHash))
        .map((event) => processEvent(event, "_value", "_to", "_from")),
    };
  }
}

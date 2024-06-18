import {
  Contract,
  BigNumber,
  paginatedEventQuery,
  Signer,
  EventSearchConfig,
  Provider,
  spreadEventWithBlockNumber,
  BigNumberish,
} from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { SortableEvent } from "../../interfaces";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import { Event } from "ethers";

export class LineaWethBridge extends BaseBridgeAdapter {
  private readonly l1Bridge: Contract;
  private readonly l2Bridge: Contract;

  private readonly atomicDepositor: Contract;

  constructor(l2chainId: number, hubChainId: number, l1Signer: Signer, l2SignerOrProvider: Signer | Provider) {
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].lineaMessageService;
    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].l2MessageService;
    const { address: atomicDepositorAddress, abi: atomicDepositorAbi } = CONTRACT_ADDRESSES[hubChainId].atomicDepositor;
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [atomicDepositorAddress]);

    this.atomicDepositor = new Contract(atomicDepositorAddress, atomicDepositorAbi, l1Signer);
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);
  }

  constructL1ToL2Txn(toAddress: string, l1Token: string, l2Token: string, amount: BigNumber): BridgeTransactionDetails {
    return {
      contract: this.atomicDepositor,
      method: "bridgeWethToLinea",
      args: [toAddress, amount],
    };
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const events = await paginatedEventQuery(
      this.l1Bridge,
      this.l1Bridge.filters.MessageSent(undefined, fromAddress),
      eventConfig
    );
    const processEvent = (event: Event) => {
      const eventSpread = spreadEventWithBlockNumber(event) as SortableEvent & {
        amount: BigNumberish;
        to: string;
        from: string;
        transactionHash: string;
      };
      return {
        amount: eventSpread["_value"],
        to: eventSpread["_to"],
        from: eventSpread["_from"],
        transactionHash: eventSpread.transactionHash,
      };
    };
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map(processEvent).filter(({ amount }) => amount > 0),
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // TODO: This can probably be refactored to save an RPC call since this is called in parallel with
    // queryL1BridgeInitiationEvents in the BaseChainAdapter class.
    const initiatedQueryResult = await paginatedEventQuery(
      this.l1Bridge,
      this.l1Bridge.filters.MessageSent(undefined, fromAddress),
      eventConfig
    );

    // @dev There will be a MessageSent to the SpokePool address for each RelayedRootBundle so remove
    // those with 0 value.
    const internalMessageHashes = initiatedQueryResult
      .filter(({ args }) => args._value.gt(0))
      .map(({ args }) => args._messageHash);
    const events = await paginatedEventQuery(
      this.l2Bridge,
      this.l2Bridge.filters.MessageClaimed(internalMessageHashes),
      eventConfig
    );
    const processEvent = (event: Event) => {
      const eventSpread = spreadEventWithBlockNumber(event) as SortableEvent & {
        amount: BigNumberish;
        to: string;
        from: string;
        transactionHash: string;
      };
      return {
        amount: eventSpread["_value"],
        to: eventSpread["_to"],
        from: eventSpread["_from"],
        transactionHash: eventSpread.transactionHash,
      };
    };
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map(processEvent),
    };
  }
}

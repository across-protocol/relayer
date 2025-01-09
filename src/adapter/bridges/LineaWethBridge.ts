import {
  Contract,
  BigNumber,
  paginatedEventQuery,
  bnZero,
  Signer,
  EventSearchConfig,
  Provider,
  getBlockForTimestamp,
  BlockFinder,
  isDefined,
} from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import { processEvent } from "../utils";

export class LineaWethBridge extends BaseBridgeAdapter {
  protected atomicDepositor: Contract;
  protected blockFinder: BlockFinder;

  // We by default do not include a fee for Linea bridges.
  protected bridgeFee = 0;

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
    const bridgeCalldata = this.getL1Bridge().interface.encodeFunctionData("sendMessage", [
      toAddress,
      this.bridgeFee,
      "0x",
    ]);
    return Promise.resolve({
      contract: this.atomicDepositor,
      method: "bridgeWeth",
      args: [this.l2chainId, amount, amount, bnZero, bridgeCalldata],
    });
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

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const l2Provider = this.getL2Bridge().provider;

    const [fromBlock, toBlock] = await Promise.all([
      l2Provider.getBlock(eventConfig.fromBlock),
      l2Provider.getBlock(eventConfig.toBlock),
    ]);

    const [l1FromBlock, l1ToBlock] = [
      await getBlockForTimestamp(this.hubChainId, fromBlock.timestamp, this.blockFinder),
      await getBlockForTimestamp(this.hubChainId, toBlock.timestamp, this.blockFinder),
    ];
    const l1SearchConfig = {
      fromBlock: l1FromBlock,
      toBlock: l1ToBlock,
    };
    const initiatedQueryResult = await paginatedEventQuery(
      this.getL1Bridge(),
      this.getL1Bridge().filters.MessageSent(undefined, toAddress),
      l1SearchConfig
    );

    // If there are no initiations, then exit early, since there will be no finalized events to match.
    // This can happen if the from/toAddress is the hub pool.
    if (initiatedQueryResult.length === 0) {
      return Promise.resolve({});
    }

    const internalMessageHashes = initiatedQueryResult
      .filter(({ args }) => args._value.gt(0))
      .map(({ args }) => args._messageHash);
    const events = await paginatedEventQuery(
      this.getL2Bridge(),
      this.getL2Bridge().filters.MessageClaimed(internalMessageHashes),
      eventConfig
    );
    const matchedEvents = events
      .map((finalized) => {
        const queryEvent = initiatedQueryResult.find(
          (initiated) => initiated.args._messageHash === finalized.args._messageHash
        );
        // It is possible for a finalized event to be observed without the corresponding initiation event
        // when the finalization event approaches the max look back value. In this case, we filter those out.
        return isDefined(queryEvent)
          ? {
              ...processEvent(queryEvent, "_value", "_to", "_from"),
              blockNumber: finalized.blockNumber,
              transactionIndex: finalized.transactionIndex,
              logIndex: finalized.logIndex,
              transactionHash: finalized.transactionHash,
            }
          : undefined;
      })
      .filter(isDefined);
    return {
      [this.resolveL2TokenAddress(l1Token)]: matchedEvents,
    };
  }
}

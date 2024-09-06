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

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const l2Provider = this.getL2Bridge().provider;
    const l1Provider = this.getL1Bridge().provider;

    const [fromBlock, toBlock] = await Promise.all([
      l2Provider.getBlock(eventConfig.fromBlock),
      l2Provider.getBlock(eventConfig.toBlock),
    ]);

    const blockFinder = new BlockFinder(l1Provider);
    const [l1FromBlock, l1ToBlock] = [
      await getBlockForTimestamp(this.hubChainId, fromBlock.timestamp, blockFinder),
      await getBlockForTimestamp(this.hubChainId, toBlock.timestamp, blockFinder),
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

    // @dev There will be a MessageSent to the SpokePool address for each RelayedRootBundle so remove
    // those with 0 value.
    const internalMessageHashes = initiatedQueryResult
      .filter(({ args }) => args._value.gt(0))
      .map(({ args }) => args._messageHash);
    const events = await paginatedEventQuery(
      this.getL2Bridge(),
      this.getL2Bridge().filters.MessageClaimed(internalMessageHashes),
      eventConfig
    );
    const finalizedHashes = events.map(({ args }) => args._messageHash);
    return {
      [this.resolveL2TokenAddress(l1Token)]: initiatedQueryResult
        .filter(({ args }) => finalizedHashes.includes(args._messageHash))
        .map((event) => processEvent(event, "_value", "_to", "_from")),
    };
  }
}

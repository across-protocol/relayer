import {
  Contract,
  BigNumber,
  paginatedEventQuery,
  Signer,
  EventSearchConfig,
  Provider,
  ZERO_ADDRESS,
  getL2TokenAddresses,
} from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import { processEvent } from "../utils";

/* Polygon has a bridge which we check for L1 <-> L2 events
 * and a token gateway which is the address used to initiate a
 * deposit
 */
export class PolygonWethBridge extends BaseBridgeAdapter {
  protected l1Bridge: Contract;
  protected l2Bridge: Contract;

  protected atomicDepositor: Contract;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l1Token: string
  ) {
    // @dev This method fetches the *SDK's* most up-to-date values of
    // TOKEN_SYMBOLS_MAP. This constructor will therefore break if
    // either the SDK, or the constants dependency in the SDK, is not
    // up-to-date.
    const l2TokenAddresses = getL2TokenAddresses(l1Token);
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].polygonWethBridge;
    const { address: atomicDepositorAddress, abi: atomicDepositorAbi } = CONTRACT_ADDRESSES[hubChainId].atomicDepositor;
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [atomicDepositorAddress]);

    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);
    this.atomicDepositor = new Contract(atomicDepositorAddress, atomicDepositorAbi, l1Signer);

    // For Polygon, we look for mint events triggered by the L2 token, not the L2 Bridge.
    const l2Abi = CONTRACT_ADDRESSES[l2chainId].withdrawableErc20.abi;
    this.l2Bridge = new Contract(l2TokenAddresses[l2chainId], l2Abi, l2SignerOrProvider);
  }

  async constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    return Promise.resolve({
      contract: this.atomicDepositor,
      method: "bridgeWethToPolygon",
      args: [toAddress, amount.toString()],
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
      this.l1Bridge.filters.LockedEther(undefined, fromAddress),
      eventConfig
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) =>
        processEvent(event, "amount", "depositReceiver", "depositor")
      ),
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
      this.l2Bridge.filters.Transfer(ZERO_ADDRESS, fromAddress),
      eventConfig
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "value", "to", "from")),
    };
  }
}

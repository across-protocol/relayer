import {
  Contract,
  BigNumber,
  paginatedEventQuery,
  Signer,
  EventSearchConfig,
  Provider,
  bnZero,
  ZERO_ADDRESS,
  getL2TokenAddresses,
  EvmAddress,
} from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import { processEvent } from "../utils";

/* Polygon has a bridge which we check for L1 <-> L2 events
 * and a token gateway which is the address used to initiate a
 * deposit
 */
export class PolygonWethBridge extends BaseBridgeAdapter {
  protected atomicDepositor: Contract;
  protected rootChainManager: Contract;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l1Token: EvmAddress
  ) {
    // @dev This method fetches the *SDK's* most up-to-date values of
    // TOKEN_SYMBOLS_MAP. This constructor will therefore break if
    // either the SDK, or the constants dependency in the SDK, is not
    // up-to-date.
    const l2TokenAddresses = getL2TokenAddresses(l1Token.toAddress(), hubChainId);
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].polygonWethBridge;
    const { address: atomicDepositorAddress, abi: atomicDepositorAbi } = CONTRACT_ADDRESSES[hubChainId].atomicDepositor;
    const { address: rootChainManagerAddress, abi: rootChainManagerAbi } =
      CONTRACT_ADDRESSES[hubChainId].polygonRootChainManager;
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [EvmAddress.from(atomicDepositorAddress)]);

    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);
    this.atomicDepositor = new Contract(atomicDepositorAddress, atomicDepositorAbi, l1Signer);
    this.rootChainManager = new Contract(rootChainManagerAddress, rootChainManagerAbi, l1Signer);

    // For Polygon, we look for mint events triggered by the L2 token, not the L2 Bridge.
    const l2Abi = CONTRACT_ADDRESSES[l2chainId].withdrawableErc20.abi;
    this.l2Bridge = new Contract(l2TokenAddresses[l2chainId], l2Abi, l2SignerOrProvider);
  }

  async constructL1ToL2Txn(
    toAddress: EvmAddress,
    l1Token: EvmAddress,
    l2Token: EvmAddress,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    const bridgeCalldata = this.rootChainManager.interface.encodeFunctionData("depositEtherFor", [
      toAddress.toAddress(),
    ]);
    return Promise.resolve({
      contract: this.atomicDepositor,
      method: "bridgeWeth",
      args: [this.l2chainId, amount, amount, bnZero, bridgeCalldata],
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
      this.getL1Bridge().filters.LockedEther(undefined, toAddress.toAddress()),
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
      this.getL2Bridge().filters.Transfer(ZERO_ADDRESS, toAddress.toAddress()),
      eventConfig
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "value")),
    };
  }
}

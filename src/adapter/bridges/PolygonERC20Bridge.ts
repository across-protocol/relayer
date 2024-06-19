import {
  Contract,
  BigNumber,
  paginatedEventQuery,
  Signer,
  EventSearchConfig,
  Provider,
  spreadEventWithBlockNumber,
  BigNumberish,
  bnToHex,
  ZERO_ADDRESS,
} from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { SortableEvent } from "../../interfaces";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import { Event } from "ethers";

/* Polygon has a bridge which we check for L1 <-> L2 events
 * and a token gateway which is the address used to initiate a
 * deposit
 */
export class PolygonERC20Bridge extends BaseBridgeAdapter {
  private readonly l1Bridge: Contract;
  private readonly l2Bridge: Contract;

  private readonly l1Gateway: Contract;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l2Token: string
  ) {
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].polygonBridge;
    const { address: l1GatewayAddress, abi: l1GatewayAbi } = CONTRACT_ADDRESSES[hubChainId].polygonRootChainManager;
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [l1GatewayAddress]);

    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);
    this.l1Gateway = new Contract(l1GatewayAddress, l1GatewayAbi, l1Signer);

    // For Polygon, we look for mint events triggered by the L2 token, not the L2 Bridge.
    const l2Abi = CONTRACT_ADDRESSES[l2chainId].withdrawableErc20.abi;
    this.l2Bridge = new Contract(l2Token, l2Abi, l2SignerOrProvider);
  }

  async constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    return Promise.resolve({
      contract: this.l1Gateway,
      method: "depositFor",
      args: [toAddress, l1Token, bnToHex(amount)],
    });
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const events = await paginatedEventQuery(
      this.l1Bridge,
      this.l1Bridge.filters.LockedERC20(undefined, fromAddress, l1Token),
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
        amount: eventSpread["_amount"],
        to: eventSpread["_to"],
        from: eventSpread["_from"],
        transactionHash: eventSpread.transactionHash,
      };
    };
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map(processEvent),
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const events = await paginatedEventQuery(
      this.l2Bridge,
      this.l2Bridge.filters.Transfer(ZERO_ADDRESS, fromAddress),
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
        amount: eventSpread["_amount"],
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

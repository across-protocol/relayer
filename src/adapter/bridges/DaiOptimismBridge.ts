import {
  Contract,
  BigNumber,
  paginatedEventQuery,
  EventSearchConfig,
  Signer,
  Provider,
  spreadEventWithBlockNumber,
  BigNumberish,
} from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { SortableEvent } from "../../interfaces";
import { BaseBridgeAdapter, BridgeTransactionDetails, BridgeEvents } from "./BaseBridgeAdapter";
import { Event } from "ethers";

export class DaiOptimismBridge extends BaseBridgeAdapter {
  private readonly l1Bridge: Contract;
  private readonly l2Bridge: Contract;

  private readonly l2Gas = 200000;

  constructor(l2chainId: number, hubChainId: number, l1Signer: Signer, l2SignerOrProvider: Signer | Provider) {
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [
      CONTRACT_ADDRESSES[hubChainId].daiOptimismBridge.address,
    ]);

    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].daiOptimismBridge;
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);

    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].daiOptimismBridge;
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);
  }

  constructL1ToL2Txn(toAddress: string, l1Token: string, l2Token: string, amount: BigNumber): BridgeTransactionDetails {
    return {
      contract: this.l1Bridge,
      method: "depositERC20",
      args: [l1Token, l2Token, amount, this.l2Gas, "0x"],
    };
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const events = await paginatedEventQuery(
      this.l1Bridge,
      this.l1Bridge.filters.ERC20DepositInitiated(l1Token, undefined, fromAddress),
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
      this.l2Bridge.filters.DepositFinalized(l1Token, undefined, fromAddress),
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

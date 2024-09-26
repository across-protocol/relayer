import { Contract, BigNumber, paginatedEventQuery, EventSearchConfig, Signer, Provider } from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { BaseBridgeAdapter, BridgeTransactionDetails, BridgeEvents } from "./BaseBridgeAdapter";
import { processEvent } from "../utils";

export class BlastBridge extends BaseBridgeAdapter {
  private readonly l2Gas = 200000;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    _l1Token: string
  ) {
    // Lint Appeasement
    _l1Token;
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].blastBridge;
    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].blastBridge;
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [l1Address]);

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
      contract: this.getL1Bridge(),
      method: "bridgeERC20",
      args: [l1Token, l2Token, amount, this.l2Gas, "0x"],
    });
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const l1Bridge = this.getL1Bridge();
    const events = await paginatedEventQuery(
      l1Bridge,
      l1Bridge.filters.ERC20BridgeInitiated(l1Token, undefined, fromAddress),
      eventConfig
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "amount", "to", "from")),
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const l2Bridge = this.getL2Bridge();
    const events = await paginatedEventQuery(
      l2Bridge,
      l2Bridge.filters.ERC20BridgeFinalized(undefined, l1Token, fromAddress),
      eventConfig
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "amount", "to", "from")),
    };
  }
}

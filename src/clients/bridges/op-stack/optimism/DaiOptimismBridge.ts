import { Contract, BigNumber, paginatedEventQuery, EventSearchConfig, Signer, Provider } from "../../../../utils";
import { CONTRACT_ADDRESSES } from "../../../../common";
import { OpStackBridge, BridgeTransactionDetails, OpStackEvents } from "../OpStackBridgeInterface";

export class DaiOptimismBridge extends OpStackBridge {
  private readonly l1Bridge: Contract;
  private readonly l2Bridge: Contract;

  constructor(l2chainId: number, hubChainId: number, l1Signer: Signer, l2SignerOrProvider: Signer | Provider) {
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [
      CONTRACT_ADDRESSES[hubChainId].daiOptimismBridge.address,
    ]);

    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].daiOptimismBridge;
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);

    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].daiOptimismBridge;
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);
  }

  protected getL1Bridge(): Contract {
    return this.l1Bridge;
  }

  protected getL2Bridge(): Contract {
    return this.l2Bridge;
  }

  constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber,
    l2Gas: number
  ): BridgeTransactionDetails {
    return {
      contract: this.getL1Bridge(),
      method: "depositERC20",
      args: [l1Token, l2Token, amount, l2Gas, "0x"],
    };
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<OpStackEvents> {
    const l1Bridge = this.getL1Bridge();
    return {
      [this.resolveL2TokenAddress(l1Token)]: await paginatedEventQuery(
        l1Bridge,
        l1Bridge.filters.ERC20DepositInitiated(l1Token, undefined, fromAddress),
        eventConfig
      ),
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<OpStackEvents> {
    const l2Bridge = this.getL2Bridge();
    return {
      [this.resolveL2TokenAddress(l1Token)]: await paginatedEventQuery(
        l2Bridge,
        l2Bridge.filters.DepositFinalized(l1Token, undefined, fromAddress),
        eventConfig
      ),
    };
  }
}

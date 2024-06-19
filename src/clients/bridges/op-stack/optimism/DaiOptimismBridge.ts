import { Contract, BigNumber, paginatedEventQuery, EventSearchConfig, Signer, Provider } from "../../../../utils";
import { CONTRACT_ADDRESSES } from "../../../../common";
import { OpStackBridge, BridgeTransactionDetails, OpStackEvents } from "../OpStackBridgeInterface";

export class DaiOptimismBridge extends OpStackBridge {
  private readonly l1Bridge: Contract;
  private readonly l2Bridge: Contract;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    bridgeAddresses: Partial<{
      l1: string;
      l2: string;
    }> = {}
  ) {
    bridgeAddresses.l1 = bridgeAddresses.l1 || CONTRACT_ADDRESSES[hubChainId].daiOptimismBridge.address;
    bridgeAddresses.l2 = bridgeAddresses.l2 || CONTRACT_ADDRESSES[l2chainId].daiOptimismBridge.address;

    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [bridgeAddresses.l1]);

    const { abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].daiOptimismBridge;
    this.l1Bridge = new Contract(bridgeAddresses.l1, l1Abi, l1Signer);

    const { abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].daiOptimismBridge;
    this.l2Bridge = new Contract(bridgeAddresses.l2, l2Abi, l2SignerOrProvider);
  }

  constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber,
    l2Gas: number
  ): BridgeTransactionDetails {
    return {
      contract: this.l1Bridge,
      method: "depositERC20",
      args: [l1Token, l2Token, amount, l2Gas, "0x"],
    };
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<OpStackEvents> {
    return {
      [this.resolveL2TokenAddress(l1Token)]: await paginatedEventQuery(
        this.l1Bridge,
        this.l1Bridge.filters.ERC20DepositInitiated(l1Token, undefined, fromAddress),
        eventConfig
      ),
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<OpStackEvents> {
    return {
      [this.resolveL2TokenAddress(l1Token)]: await paginatedEventQuery(
        this.l2Bridge,
        this.l2Bridge.filters.DepositFinalized(l1Token, undefined, fromAddress),
        eventConfig
      ),
    };
  }
}

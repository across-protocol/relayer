import { BigNumber, Contract, Signer } from "ethers";
import { CONTRACT_ADDRESSES, chainIdsToCctpDomains } from "../../../common";
import { BridgeTransactionDetails, OpStackBridge, OpStackEvents } from "./OpStackBridgeInterface";
import { EventSearchConfig, Provider, TOKEN_SYMBOLS_MAP } from "../../../utils";
import { cctpAddressToBytes32, retrieveOutstandingCCTPBridgeUSDCTransfers } from "../../../utils/CCTPUtils";

export class UsdcCCTPBridge extends OpStackBridge {
  private readonly l1CctpTokenBridge: Contract;
  private readonly l2CctpMessageTransmitter: Contract;

  constructor(l2chainId: number, hubChainId: number, l1Signer: Signer, l2SignerOrProvider: Signer | Provider) {
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [
      CONTRACT_ADDRESSES[hubChainId].cctpTokenMessenger.address,
    ]);

    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].cctpTokenMessenger;
    this.l1CctpTokenBridge = new Contract(l1Address, l1Abi, l1Signer);

    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].cctpMessageTransmitter;
    this.l2CctpMessageTransmitter = new Contract(l2Address, l2Abi, l2SignerOrProvider);
  }

  private get l2DestinationDomain(): number {
    return chainIdsToCctpDomains[this.l2chainId];
  }

  private get l1UsdcTokenAddress(): string {
    return TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId];
  }

  protected getL1Bridge(): Contract {
    return this.l1CctpTokenBridge;
  }

  protected getL2Bridge(): Contract {
    return this.l2CctpMessageTransmitter;
  }

  protected resolveL2TokenAddress(l1Token: string): string {
    l1Token;
    return TOKEN_SYMBOLS_MAP.USDC.addresses[this.l2chainId];
  }

  constructL1ToL2Txn(
    toAddress: string,
    _l1Token: string,
    _l2Token: string,
    amount: BigNumber,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _l2Gas: number
  ): BridgeTransactionDetails {
    return {
      contract: this.getL1Bridge(),
      method: "depositForBurn",
      args: [amount, this.l2DestinationDomain, cctpAddressToBytes32(toAddress), this.l1UsdcTokenAddress],
    };
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<OpStackEvents> {
    return {
      [this.resolveL2TokenAddress(l1Token)]: await retrieveOutstandingCCTPBridgeUSDCTransfers(
        this.getL1Bridge(),
        this.getL2Bridge(),
        eventConfig,
        this.l1UsdcTokenAddress,
        this.hubChainId,
        this.l2chainId,
        fromAddress
      ),
    };
  }
  queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<OpStackEvents> {
    // Lint Appeasement
    l1Token;
    fromAddress;
    eventConfig;

    // Per the documentation of the BaseAdapter's computeOutstandingCrossChainTransfers method, we can return an empty array here
    // and only return the relevant outstanding events from queryL1BridgeInitiationEvents.
    // Relevant link: https://github.com/across-protocol/relayer/blob/master/src/clients/bridges/BaseAdapter.ts#L189
    return Promise.resolve({});
  }
}

import { BigNumber, Contract, Event, Signer } from "ethers";
import { CONTRACT_ADDRESSES, chainIdsToCctpDomains } from "../../../common";
import { BridgeTransactionDetails, OpStackBridge } from "./OpStackBridgeInterface";
import { EventSearchConfig, Provider, TOKEN_SYMBOLS_MAP, paginatedEventQuery } from "../../../utils";
import { cctpAddressToBytes32 } from "../../../utils/CCTPUtils";

export class UsdcCCTPBridge implements OpStackBridge {
  private readonly l1CctpTokenBridge: Contract;
  private readonly l2CctpTokenBridge: Contract;

  constructor(
    private l2chainId: number,
    private hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider
  ) {
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].cctpTokenMessenger;
    this.l1CctpTokenBridge = new Contract(l1Address, l1Abi, l1Signer);

    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].cctpTokenMessenger;
    this.l2CctpTokenBridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);
  }

  private get l2DestinationDomain(): number {
    return chainIdsToCctpDomains[this.l2chainId];
  }

  private get l1UsdcTokenAddress(): string {
    return TOKEN_SYMBOLS_MAP._USDC.addresses[this.hubChainId];
  }

  private get l2UsdcTokenAddress(): string {
    return TOKEN_SYMBOLS_MAP._USDC.addresses[this.l2chainId];
  }

  get l1Gateway(): string {
    return this.l1CctpTokenBridge.address;
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
      contract: this.l1CctpTokenBridge,
      method: "depositForBurn",
      args: [amount, this.l2DestinationDomain, cctpAddressToBytes32(toAddress), this.l1UsdcTokenAddress],
    };
  }

  queryL1BridgeInitiationEvents(
    _l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<Event[]> {
    return paginatedEventQuery(
      this.l1CctpTokenBridge,
      this.l1CctpTokenBridge.filters.DepositForBurn(undefined, this.l1UsdcTokenAddress, undefined, fromAddress),
      eventConfig
    );
  }
  queryL2BridgeFinalizationEvents(
    _l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<Event[]> {
    return paginatedEventQuery(
      this.l2CctpTokenBridge,
      this.l2CctpTokenBridge.filters.MintAndWithdraw(undefined, undefined, this.l2UsdcTokenAddress),
      eventConfig
    );
  }
}

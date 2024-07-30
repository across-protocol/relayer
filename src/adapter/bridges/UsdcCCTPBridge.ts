import { BigNumber, Contract, Signer } from "ethers";
import { CONTRACT_ADDRESSES, chainIdsToCctpDomains } from "../../common";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import { EventSearchConfig, Provider, TOKEN_SYMBOLS_MAP, compareAddressesSimple, assert, isDefined } from "../../utils";
import { processEvent } from "../utils";
import { cctpAddressToBytes32, retrieveOutstandingCCTPBridgeUSDCTransfers } from "../../utils/CCTPUtils";

export class UsdcCCTPBridge extends BaseBridgeAdapter {
  constructor(l2chainId: number, hubChainId: number, l1Signer: Signer, l2SignerOrProvider: Signer | Provider) {
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [
      CONTRACT_ADDRESSES[hubChainId].cctpTokenMessenger.address,
    ]);

    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].cctpTokenMessenger;
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);

    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].cctpMessageTransmitter ?? {};
    if (isDefined(l2Address)) { this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider); }
  }

  private get l2DestinationDomain(): number {
    return chainIdsToCctpDomains[this.l2chainId];
  }

  private get l1UsdcTokenAddress(): string {
    return TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId];
  }

  async constructL1ToL2Txn(
    toAddress: string,
    _l1Token: string,
    _l2Token: string,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    assert(compareAddressesSimple(_l1Token, TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]));
    assert(this.isCCTPEnabled());
    return Promise.resolve({
      contract: this.getL1Bridge(),
      method: "depositForBurn",
      args: [amount, this.l2DestinationDomain, cctpAddressToBytes32(toAddress), this.l1UsdcTokenAddress],
    });
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    assert(compareAddressesSimple(l1Token, TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]));
    if (!this.isCCTPEnabled()) { return Promise.resolve({}); }
    const events = await retrieveOutstandingCCTPBridgeUSDCTransfers(
      this.getL1Bridge(),
      this.getL2Bridge(),
      eventConfig,
      this.l1UsdcTokenAddress,
      this.hubChainId,
      this.l2chainId,
      fromAddress
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) =>
        processEvent(event, "amount", "mintRecipient", "depositor")
      ),
    };
  }

  queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // Lint Appeasement
    l1Token;
    fromAddress;
    eventConfig;
    assert(compareAddressesSimple(l1Token, TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]));

    // The function queryL1BridgeInitiationEvents already comuptes outstanding CCTP Bridge transfers,
    // so we can return nothing here.
    return Promise.resolve({});
  }

  // There will always be a message transmitter on L1, so we know that CCTP is enabled for L2 if there exists
  // a message transmitter for L2.
  isCCTPEnabled(): boolean {
    return isDefined(this.l2Bridge);
  }

  override resolveL2TokenAddress(l1Token: string): string {
    l1Token;
    return TOKEN_SYMBOLS_MAP.USDC.addresses[this.l2chainId];
  }
}

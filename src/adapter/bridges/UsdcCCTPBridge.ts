import { Contract, Signer } from "ethers";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import {
  BigNumber,
  EventSearchConfig,
  Provider,
  TOKEN_SYMBOLS_MAP,
  compareAddressesSimple,
  assert,
  toBN,
  getCctpDomainForChainId,
  Address,
  EvmAddress,
  paginatedEventQuery,
  ethers,
} from "../../utils";
import { processEvent } from "../utils";
import { getCctpTokenMessenger, isCctpV2L2ChainId } from "../../utils/CCTPUtils";
import { CCTP_NO_DOMAIN } from "@across-protocol/constants";

export class UsdcCCTPBridge extends BaseBridgeAdapter {
  private CCTP_MAX_SEND_AMOUNT = toBN(1_000_000_000_000); // 1MM USDC.
  private IS_CCTP_V2 = false;
  private readonly l1UsdcTokenAddress: EvmAddress;

  constructor(l2chainId: number, hubChainId: number, l1Signer: Signer, l2SignerOrProvider: Signer | Provider) {
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [
      EvmAddress.from(getCctpTokenMessenger(l2chainId, hubChainId).address),
    ]);
    assert(
      getCctpDomainForChainId(l2chainId) !== CCTP_NO_DOMAIN && getCctpDomainForChainId(hubChainId) !== CCTP_NO_DOMAIN,
      "Unknown CCTP domain ID"
    );
    this.IS_CCTP_V2 = isCctpV2L2ChainId(l2chainId);

    const { address: l1Address, abi: l1Abi } = getCctpTokenMessenger(l2chainId, hubChainId);
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);

    const { address: l2TokenMessengerAddress, abi: l2TokenMessengerAbi } = getCctpTokenMessenger(l2chainId, l2chainId);
    this.l2Bridge = new Contract(l2TokenMessengerAddress, l2TokenMessengerAbi, l2SignerOrProvider);

    this.l1UsdcTokenAddress = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]);
  }

  private get l2DestinationDomain(): number {
    return getCctpDomainForChainId(this.l2chainId);
  }

  protected resolveL2TokenAddress(l1Token: EvmAddress): string {
    l1Token;
    return TOKEN_SYMBOLS_MAP.USDC.addresses[this.l2chainId];
  }

  async constructL1ToL2Txn(
    toAddress: Address,
    l1Token: EvmAddress,
    _l2Token: Address,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    assert(l1Token.eq(this.l1UsdcTokenAddress));
    amount = amount.gt(this.CCTP_MAX_SEND_AMOUNT) ? this.CCTP_MAX_SEND_AMOUNT : amount;
    return Promise.resolve({
      contract: this.getL1Bridge(),
      method: "depositForBurn",
      args: this.IS_CCTP_V2
        ? [
            amount,
            this.l2DestinationDomain,
            toAddress.toBytes32(),
            this.l1UsdcTokenAddress.toAddress(),
            ethers.constants.HashZero, // Anyone can finalize the message on domain when this is set to bytes32(0)
            0, // maxFee set to 0 so this will be a "standard" speed transfer
            2000, // Hardcoded minFinalityThreshold value for standard transfer
          ]
        : [amount, this.l2DestinationDomain, toAddress.toBytes32(), this.l1UsdcTokenAddress.toAddress()],
    });
  }

  async queryL1BridgeInitiationEvents(
    l1Token: EvmAddress,
    fromAddress: EvmAddress,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    assert(l1Token.eq(this.l1UsdcTokenAddress));
    const eventFilterArgs = this.IS_CCTP_V2
      ? [this.l1UsdcTokenAddress.toAddress(), undefined, fromAddress.toAddress()]
      : [undefined, this.l1UsdcTokenAddress.toAddress(), undefined, fromAddress.toAddress()];
    const eventFilter = this.getL1Bridge().filters.DepositForBurn(...eventFilterArgs);
    const events = (await paginatedEventQuery(this.getL1Bridge(), eventFilter, eventConfig)).filter(
      (event) =>
        compareAddressesSimple(event.args.mintRecipient, toAddress.toBytes32()) &&
        event.args.destinationDomain === this.l2DestinationDomain
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "amount")),
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: EvmAddress,
    fromAddress: EvmAddress,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    assert(l1Token.eq(this.l1UsdcTokenAddress));
    const eventFilterArgs = [toAddress.toAddress(), undefined, this.resolveL2TokenAddress(this.l1UsdcTokenAddress)];
    const eventFilter = this.getL2Bridge().filters.MintAndWithdraw(...eventFilterArgs);
    const events = await paginatedEventQuery(this.getL2Bridge(), eventFilter, eventConfig);
    // There is no "from" field in this event, so we set it to the L2 token received.
    return {
      [this.resolveL2TokenAddress(this.l1UsdcTokenAddress)]: events.map((event) => processEvent(event, "amount")),
    };
  }
}

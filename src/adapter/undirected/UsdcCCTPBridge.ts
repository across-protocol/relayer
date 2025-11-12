import { Contract, Signer } from "ethers";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "../BaseBridgeAdapter";
import {
  BigNumber,
  EventSearchConfig,
  Provider,
  TOKEN_SYMBOLS_MAP,
  compareAddressesSimple,
  assert,
  getCctpDomainForChainId,
  Address,
  EvmAddress,
  paginatedEventQuery,
  ethers,
  winston,
  spreadEventWithBlockNumber,
  toBN,
  bnZero,
} from "../../utils";
import { processEvent, TransferTokenParams } from "../utils";
import {
  getCctpV2TokenMessenger,
  getV2DepositForBurnMaxFee,
  CCTPV2_FINALITY_THRESHOLD_STANDARD,
} from "../../utils/CCTPUtils";
import { CCTP_NO_DOMAIN } from "@across-protocol/constants";
import { CCTP_MAX_SEND_AMOUNT } from "../../common";
import { SortableEvent } from "../../interfaces";

export class UsdcCCTPBridge extends BaseBridgeAdapter<Signer, Signer | Provider> {
  private IS_CCTP_V2 = false;
  private readonly l1UsdcTokenAddress: EvmAddress;

  constructor(
    dstChainId: number,
    srcChainId: number,
    srcSigner: Signer,
    dstSignerOrProvider: Signer | Provider,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    srcToken: EvmAddress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _logger: winston.Logger
  ) {
    const { address: l1Address, abi: l1Abi } = getCctpV2TokenMessenger(srcChainId);
    super(dstChainId, srcChainId, srcSigner, dstSignerOrProvider, [EvmAddress.from(l1Address)]);
    assert(
      getCctpDomainForChainId(dstChainId) !== CCTP_NO_DOMAIN && getCctpDomainForChainId(srcChainId) !== CCTP_NO_DOMAIN,
      "Unknown CCTP domain ID"
    );

    this.l1Bridge = new Contract(l1Address, l1Abi, srcSigner);

    const { address: l2TokenMessengerAddress, abi: l2TokenMessengerAbi } = getCctpV2TokenMessenger(dstChainId);
    this.l2Bridge = new Contract(l2TokenMessengerAddress, l2TokenMessengerAbi, dstSignerOrProvider);

    this.l1UsdcTokenAddress = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[this.srcChainId]);
  }

  private get l2DestinationDomain(): number {
    return getCctpDomainForChainId(this.dstChainId);
  }

  protected resolveL2TokenAddress(srcToken: EvmAddress): string {
    srcToken;
    return TOKEN_SYMBOLS_MAP.USDC.addresses[this.dstChainId];
  }

  async constructL1ToL2Txn(
    toAddress: Address,
    srcToken: EvmAddress,
    _l2Token: Address,
    amount: BigNumber,
    optionalParams?: TransferTokenParams
  ): Promise<BridgeTransactionDetails> {
    assert(srcToken.eq(this.l1UsdcTokenAddress));
    // Check for fast-transfer allowance and also min fee, and if they are reasonable, then
    // construct a fast transfer, otherwise default to a standard transfer.
    amount = amount.gt(CCTP_MAX_SEND_AMOUNT) ? CCTP_MAX_SEND_AMOUNT : amount;
    let maxFee = bnZero,
      finalityThreshold = CCTPV2_FINALITY_THRESHOLD_STANDARD;
    if (optionalParams?.fastMode) {
      ({ maxFee, finalityThreshold } = await this._getCctpV2DepositForBurnMaxFee(amount));
    }
    // Add maxFee so that we end up with desired amount of tokens on destination chain.
    const amountWithFee = amount.add(maxFee);
    const amountToSend = amountWithFee.gt(CCTP_MAX_SEND_AMOUNT) ? CCTP_MAX_SEND_AMOUNT : amountWithFee;
    return Promise.resolve({
      contract: this.getL1Bridge(),
      method: "depositForBurn",
      args: [
        amountToSend,
        this.l2DestinationDomain,
        toAddress.toBytes32(),
        this.l1UsdcTokenAddress.toNative(),
        ethers.constants.HashZero, // Anyone can finalize the message on domain when this is set to bytes32(0)
        maxFee,
        finalityThreshold,
      ],
    });
  }

  async queryL1BridgeInitiationEvents(
    srcToken: EvmAddress,
    fromAddress: EvmAddress,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    assert(srcToken.eq(this.l1UsdcTokenAddress));
    const eventFilterArgs = [this.l1UsdcTokenAddress.toNative(), undefined, fromAddress.toNative()];
    const eventFilter = this.getL1Bridge().filters.DepositForBurn(...eventFilterArgs);
    const events = (await paginatedEventQuery(this.getL1Bridge(), eventFilter, eventConfig)).filter(
      (event) =>
        compareAddressesSimple(event.args.mintRecipient, toAddress.toBytes32()) &&
        event.args.destinationDomain === this.l2DestinationDomain
    );
    return {
      [this.resolveL2TokenAddress(srcToken)]: events.map((event) => processEvent(event, "amount")),
    };
  }

  async queryL2BridgeFinalizationEvents(
    srcToken: EvmAddress,
    fromAddress: EvmAddress,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    assert(srcToken.eq(this.l1UsdcTokenAddress));
    const eventFilterArgs = [toAddress.toNative(), undefined, this.resolveL2TokenAddress(this.l1UsdcTokenAddress)];
    const eventFilter = this.getL2Bridge().filters.MintAndWithdraw(...eventFilterArgs);
    const events = await paginatedEventQuery(this.getL2Bridge(), eventFilter, eventConfig);
    // There is no "from" field in this event, so we set it to the L2 token received.
    return {
      [this.resolveL2TokenAddress(this.l1UsdcTokenAddress)]: events.map((event) => {
        const eventSpread = spreadEventWithBlockNumber(event) as SortableEvent & {
          amount: string;
          feeCollected: string;
        };
        const amount = toBN(eventSpread.amount);
        const feeCollected = toBN(eventSpread.feeCollected);
        return {
          ...eventSpread,
          amount: amount.add(feeCollected),
        };
      }),
    };
  }

  async _getCctpV2DepositForBurnMaxFee(amount: BigNumber): Promise<{ maxFee: BigNumber; finalityThreshold: number }> {
    return getV2DepositForBurnMaxFee(this.l1UsdcTokenAddress, this.srcChainId, this.dstChainId, amount);
  }
}

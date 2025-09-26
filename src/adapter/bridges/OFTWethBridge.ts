import { Contract, Signer } from "ethers";
import { BridgeTransactionDetails, BridgeEvents } from "./BaseBridgeAdapter";
import { CONTRACT_ADDRESSES } from "../../common";
import {
  BigNumber,
  Provider,
  EvmAddress,
  Address,
  winston,
  bnZero,
  EventSearchConfig,
  paginatedEventQuery,
} from "../../utils";
import { OFTBridge } from "./";
import { processEvent } from "../utils";

export class OFTWethBridge extends OFTBridge {
  private readonly atomicDepositor: Contract;

  constructor(
    l2ChainId: number,
    l1ChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    public readonly l1TokenAddress: EvmAddress,
    logger: winston.Logger
  ) {
    super(l2ChainId, l1ChainId, l1Signer, l2SignerOrProvider, l1TokenAddress, logger);

    const { address: atomicDepositorAddress, abi: atomicDepositorAbi } =
      CONTRACT_ADDRESSES[this.hubChainId].atomicDepositor;
    this.atomicDepositor = new Contract(atomicDepositorAddress, atomicDepositorAbi, l1Signer);

    // Overwrite the l1 gateway to the atomic depositor address.
    this.l1Gateways = [EvmAddress.from(atomicDepositorAddress)];
  }

  async constructL1ToL2Txn(
    toAddress: Address,
    l1Token: EvmAddress,
    _l2Token: Address,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    const { sendParamStruct, feeStruct, refundAddress } = await this.buildOftTransactionArgs(
      toAddress,
      l1Token,
      amount
    );
    const bridgeCalldata = this.getL1Bridge().interface.encodeFunctionData("send", [
      sendParamStruct,
      feeStruct,
      refundAddress,
    ]);
    const netValue = feeStruct.nativeFee.add(sendParamStruct.amountLD);
    return {
      contract: this.atomicDepositor,
      method: "bridgeWeth",
      args: [this.l2chainId, netValue, sendParamStruct.amountLD, bnZero, bridgeCalldata],
    };
  }

  // We must override the OFTBridge's `queryL1BridgeInitiationEvents` since the depositor into the OFT adapter is the atomic depositor.
  // This means if we query off of the OFT adapter, we wouldn't be able to distinguish which deposits correspond to which EOAs.
  async queryL1BridgeInitiationEvents(
    l1Token: EvmAddress,
    fromAddress: Address,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // Return no events if the query is for a different l1 token
    if (!l1Token.eq(this.l1TokenAddress)) {
      return {};
    }

    // Return no events if the query is for hubPool
    if (fromAddress.eq(this.hubPoolAddress)) {
      return {};
    }

    const isAssociatedSpokePool = this.spokePoolAddress.eq(toAddress);
    const events = await paginatedEventQuery(
      this.atomicDepositor,
      this.atomicDepositor.filters.AtomicWethDepositInitiated(
        isAssociatedSpokePool ? this.hubPoolAddress.toNative() : fromAddress.toNative(), // from
        this.l2chainId // destinationChainId
      ),
      eventConfig
    );

    return {
      [this.l2TokenAddress]: events.map((event) => {
        return processEvent(event, "amount");
      }),
    };
  }
}

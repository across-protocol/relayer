import { Contract, Signer } from "ethers";
import { BridgeTransactionDetails } from "./BaseBridgeAdapter";
import { CONTRACT_ADDRESSES } from "../../common";
import { BigNumber, Provider, EvmAddress, Address, winston, bnZero } from "../../utils";
import { OFTBridge } from "./";

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
    super(l2ChainId, l2ChainId, l1Signer, l2SignerOrProvider, l1TokenAddress, logger);

    const { address: atomicDepositorAddress, abi: atomicDepositorAbi } =
      CONTRACT_ADDRESSES[this.hubChainId].atomicDepositor;
    this.atomicDepositor = new Contract(atomicDepositorAddress, atomicDepositorAbi, l1Signer);
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
}

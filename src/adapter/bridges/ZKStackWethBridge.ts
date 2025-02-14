import assert from "assert";
import { Contract, BigNumber, Signer, Provider, ZERO_ADDRESS, bnZero } from "../../utils";
import { ZKStackBridge } from "./";
import { CONTRACT_ADDRESSES } from "../../common";
import { BridgeTransactionDetails } from "./BaseBridgeAdapter";

const ETH_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000001";
export class ZKStackWethBridge extends ZKStackBridge {
  private readonly atomicDepositor;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l1Token: string
  ) {
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, l1Token);
    const { address: atomicDepositorAddress, abi: atomicDepositorAbi } = CONTRACT_ADDRESSES[hubChainId].atomicDepositor;
    this.atomicDepositor = new Contract(atomicDepositorAddress, atomicDepositorAbi, l1Signer);

    // Overwrite the bridge gateway to the correct gateway. The correct gateway is the atomic depositor since this is the
    // address which is pulling weth out of the relayer via a `transferFrom`.
    this.l1Gateways = [atomicDepositorAddress];
  }

  override async constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    assert(l1Token === ETH_TOKEN_ADDRESS);
    const txBaseCost = await this._txBaseCost();
    const secondBridgeCalldata = this._secondBridgeCalldata(toAddress, l1Token, bnZero);

    const bridgeCalldata = this.getL1Bridge().interface.encodeFunctionData("requestL2TransactionTwoBridges", [
      [
        this.l2chainId,
        txBaseCost,
        0,
        this.l2GasLimit,
        this.gasPerPubdataLimit,
        toAddress,
        this.sharedBridgeAddress,
        amount,
        secondBridgeCalldata,
      ],
    ]);
    const usingCustomGasToken = this.gasToken !== ZERO_ADDRESS;
    const netValue = usingCustomGasToken ? amount : amount.add(txBaseCost);
    const feeAmount = usingCustomGasToken ? txBaseCost : bnZero;

    return Promise.resolve({
      contract: this.getAtomicDepositor(),
      method: "bridgeWeth",
      args: [this.l2chainId, netValue, amount, feeAmount, bridgeCalldata],
    });
  }

  private getAtomicDepositor(): Contract {
    return this.atomicDepositor;
  }
}

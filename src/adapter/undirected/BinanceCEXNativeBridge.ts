import { Contract, BigNumber, Signer, Provider, EvmAddress, assert, bnZero, winston } from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { BridgeTransactionDetails } from "../BaseBridgeAdapter";
import { BinanceCEXBridge } from "./";

export class BinanceCEXNativeBridge extends BinanceCEXBridge {
  protected readonly atomicDepositor: Contract;
  protected readonly transferProxy: Contract;
  constructor(
    dstChainId: number,
    srcChainId: number,
    srcSigner: Signer,
    dstSignerOrProvider: Signer | Provider,
    srcToken: EvmAddress,
    logger: winston.Logger
  ) {
    // No L1 gateways needed since no L1 bridge transfers tokens from the EOA.
    super(dstChainId, srcChainId, srcSigner, dstSignerOrProvider, srcToken, logger);

    const { address: atomicDepositorAddress, abi: atomicDepositorAbi } =
      CONTRACT_ADDRESSES[this.srcChainId].atomicDepositor;
    this.atomicDepositor = new Contract(atomicDepositorAddress, atomicDepositorAbi, this.srcSigner);

    const { address: transferProxyAddress, abi: transferProxyAbi } =
      CONTRACT_ADDRESSES[this.srcChainId].atomicDepositorTransferProxy;
    this.transferProxy = new Contract(transferProxyAddress, transferProxyAbi);
    // Overwrite the token symbol to ETH.
    this.tokenSymbol = "ETH";
    // Also overwrite the l1Gateway to the atomic depositor.
    this.srcGateways = [EvmAddress.from(this.atomicDepositor.address)];
  }

  override async constructL1ToL2Txn(
    _toAddress: EvmAddress,
    srcToken: EvmAddress,
    _l2Token: EvmAddress,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    assert(srcToken.toNative() === this.getL1Bridge().address);
    // Fetch the deposit address from the binance API.

    const binanceApiClient = await this.getBinanceClient();
    const depositAddress = await binanceApiClient.depositAddress({
      coin: this.tokenSymbol,
      network: "ETH",
    });
    // We need to call the atomic depositor, which calls the transfer proxy, which transfers raw ETH to the deposit Address.
    const bridgeCalldata = this.transferProxy.interface.encodeFunctionData("transfer", [depositAddress.address]);

    // Once we have the address, create a transfer to the deposit address routed via the multicall handler. Then, call the atomic depositor.
    return {
      method: "bridgeWeth",
      args: [this.dstChainId, amount, amount, bnZero, bridgeCalldata],
      contract: this.atomicDepositor,
    };
  }
}

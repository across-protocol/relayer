import { Contract, BigNumber, Signer, Provider, EvmAddress, assert, bnZero } from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { BridgeTransactionDetails } from "./BaseBridgeAdapter";
import { BinanceCEXBridge } from "./";

export class BinanceCEXNativeBridge extends BinanceCEXBridge {
  protected readonly atomicDepositor: Contract;
  protected readonly transferProxy: Contract;
  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l1Token: EvmAddress
  ) {
    // No L1 gateways needed since no L1 bridge transfers tokens from the EOA.
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, l1Token);

    const { address: atomicDepositorAddress, abi: atomicDepositorAbi } =
      CONTRACT_ADDRESSES[this.hubChainId].atomicDepositor;
    this.atomicDepositor = new Contract(atomicDepositorAddress, atomicDepositorAbi, this.l1Signer);

    const { address: transferProxyAddress, abi: transferProxyAbi } =
      CONTRACT_ADDRESSES[this.hubChainId].atomicDepositorTransferProxy;
    this.transferProxy = new Contract(transferProxyAddress, transferProxyAbi);
    // Overwrite the token symbol to ETH.
    this.tokenSymbol = "ETH";
    // Also overwrite the l1Gateway to the atomic depositor.
    this.l1Gateways = [EvmAddress.from(this.atomicDepositor.address)];
  }

  override async constructL1ToL2Txn(
    _toAddress: EvmAddress,
    l1Token: EvmAddress,
    _l2Token: EvmAddress,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    assert(l1Token.toAddress() === this.getL1Bridge().address);
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
      args: [this.l2chainId, amount, amount, bnZero, bridgeCalldata],
      contract: this.atomicDepositor,
    };
  }
}

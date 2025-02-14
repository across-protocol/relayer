import { Contract, BigNumber, Signer, EventSearchConfig, Provider, ethers, TOKEN_SYMBOLS_MAP } from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import * as zksync from "zksync-ethers";
import { gasPriceOracle } from "@across-protocol/sdk";
import { PUBLIC_NETWORKS } from "@across-protocol/constants";

/* For both the canonical bridge (this bridge) and the ZkStackWethBridge
 * bridge, we need to assume that the l1 and l2 signers contain
 * associated providers, since we need to get information about
 * addresses and gas prices (this is also why `constructL1toL2Txn`
 * is an async fn).
 */
export class ZKStackBridge extends BaseBridgeAdapter {
  readonly gasPerPubdataLimit = zksync.utils.REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_LIMIT;
  readonly l2GasLimit = BigNumber.from(2_000_000);
  readonly sharedBridgeAddress;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    _l1Token: string
  ) {
    // Lint Appeasement
    _l1Token;
    const sharedBridgeAddress = CONTRACT_ADDRESSES[hubChainId][`zkStackSharedBridge_${l2chainId}`].address;
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [sharedBridgeAddress]);

    const nativeToken = PUBLIC_NETWORKS[l2chainId].nativeToken;
    // Only set nonstandard gas tokens.
    if (nativeToken !== "ETH") {
      this.gasToken = TOKEN_SYMBOLS_MAP[nativeToken].addresses[hubChainId];
    }

    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].zkStackBridgeHub;
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);

    this.sharedBridgeAddress = sharedBridgeAddress;

    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].zkSyncDefaultErc20Bridge;
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);
  }

  async constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    // The zkStack bridges need to know the l2 gas price bid beforehand. If this bid is too small, the transaction will revert.
    const txBaseCost = await this._txBaseCost();
    const secondBridgeCalldata = this._secondBridgeCalldata(toAddress, l1Token, amount);

    // The method/arguments change depending on whether or not we are bridging the gas token or another ERC20.
    const bridgingGasToken = l1Token === this.gasToken;
    const method = bridgingGasToken ? "requestL2TransactionDirect" : "requestL2TransactionTwoBridges";
    const args = bridgingGasToken
      ? [
          [
            this.l2chainId,
            txBaseCost.add(amount),
            toAddress,
            amount,
            "0x",
            this.l2GasLimit,
            this.gasPerPubdataLimit,
            [],
            toAddress,
          ],
        ]
      : [
          [
            this.l2chainId,
            txBaseCost,
            0,
            this.l2GasLimit,
            this.gasPerPubdataLimit,
            toAddress,
            this.sharedBridgeAddress,
            0,
            secondBridgeCalldata,
          ],
        ];

    return Promise.resolve({
      contract: this.getL1Bridge(),
      method,
      args,
    });
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    return Promise.resolve({});
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    return Promise.resolve({});
  }

  _secondBridgeCalldata(toAddress: string, l1Token: string, amount: BigNumber): string {
    return ethers.utils.defaultAbiCoder.encode(["address", "uint256", "address"], [l1Token, amount, toAddress]);
  }

  async _txBaseCost(): Promise<BigNumber> {
    const l1GasPriceData = await gasPriceOracle.getGasPriceEstimate(this.getL1Bridge().provider!);

    // Similar to the ZkSyncBridge types, we must calculate the l2 gas cost by querying, a system contract. In this case,
    // the system contract to query is the bridge hub contract.
    const estimatedL1GasPrice = l1GasPriceData.maxPriorityFeePerGas.add(l1GasPriceData.maxFeePerGas);
    const l2Gas = await this.getL1Bridge().l2TransactionBaseCost(
      this.l2chainId,
      estimatedL1GasPrice,
      this.l2GasLimit,
      this.gasPerPubdataLimit
    );
    return l2Gas;
  }
}

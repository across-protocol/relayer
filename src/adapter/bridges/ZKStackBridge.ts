import {
  Contract,
  BigNumber,
  Signer,
  EventSearchConfig,
  Provider,
  ethers,
  TOKEN_SYMBOLS_MAP,
  compareAddressesSimple,
  paginatedEventQuery,
  isContractDeployedToAddress,
} from "../../utils";
import { processEvent } from "../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import { gasPriceOracle } from "@across-protocol/sdk";
import { PUBLIC_NETWORKS } from "@across-protocol/constants";
import * as zksync from "zksync-ethers";

// Scale gas price estimates by 20%.
const FEE_SCALER_NUMERATOR = 12;
const FEE_SCALER_DENOMINATOR = 10;

/* For both the canonical bridge (this bridge) and the ZkStackWethBridge
 * bridge, we need to assume that the l1 and l2 signers contain
 * associated providers, since we need to get information about
 * addresses and gas prices (this is also why `constructL1toL2Txn`
 * is an async fn).
 */
export class ZKStackBridge extends BaseBridgeAdapter {
  readonly gasPerPubdataLimit = zksync.utils.REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_LIMIT;
  readonly l2GasLimit = BigNumber.from(2_000_000);
  readonly sharedBridge: Contract;
  readonly hubPool: Contract;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _l1Token: string
  ) {
    const { address: sharedBridgeAddress, abi: sharedBridgeAbi } = CONTRACT_ADDRESSES[hubChainId].zkStackSharedBridge;
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [sharedBridgeAddress]);
    this.sharedBridge = new Contract(sharedBridgeAddress, sharedBridgeAbi, l1Signer);

    const nativeToken = PUBLIC_NETWORKS[l2chainId].nativeToken;
    // Only set nonstandard gas tokens.
    if (nativeToken !== "ETH") {
      this.gasToken = TOKEN_SYMBOLS_MAP[nativeToken].addresses[hubChainId];
    }

    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].zkStackBridgeHub;
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);

    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].zkStackBridge;
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);

    // This bridge treats hub pool transfers differently from EOA rebalances, so we must know the hub pool address.
    const { address: hubPoolAddress, abi: hubPoolAbi } = CONTRACT_ADDRESSES[hubChainId].hubPool;
    this.hubPool = new Contract(hubPoolAddress, hubPoolAbi, l1Signer);
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
    const method = "requestL2TransactionTwoBridges";
    const args = [
      [
        this.l2chainId,
        txBaseCost,
        0,
        this.l2GasLimit,
        this.gasPerPubdataLimit,
        toAddress,
        this.sharedBridge.address,
        0,
        secondBridgeCalldata,
      ],
    ];

    return {
      contract: this.getL1Bridge(),
      method,
      args,
      value: txBaseCost,
    };
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // Logic changes based on whether we are sending tokens to the spoke pool or to an EOA.
    const isL2Contract = await this._isContract(toAddress, this.getL2Bridge().provider!);
    const annotatedFromAddress = isL2Contract ? this.hubPool.address : fromAddress;
    const rawEvents = await paginatedEventQuery(
      this.sharedBridge,
      this.sharedBridge.filters.BridgehubDepositInitiated(this.l2chainId, undefined, annotatedFromAddress),
      eventConfig
    );
    const bridgeEvents = rawEvents.filter(
      (event) => compareAddressesSimple(event.args.l1Token, l1Token) && compareAddressesSimple(event.args.to, toAddress)
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: bridgeEvents.map((event) => processEvent(event, "amount", "to", "from")),
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const l2Token = this.resolveL2TokenAddress(l1Token);
    // Similar to the query, if we are sending to the spoke pool, we must assume that the sender is the hubPool,
    // so we add a special case for this reason.
    const isSpokePool = await isContractDeployedToAddress(toAddress, this.l2Bridge.provider);
    const events = isSpokePool
      ? await paginatedEventQuery(
          this.getL2Bridge(),
          this.getL2Bridge().filters.FinalizeDeposit(this.hubPool.address, toAddress, l2Token),
          eventConfig
        )
      : await paginatedEventQuery(
          this.getL2Bridge(),
          this.getL2Bridge().filters.FinalizeDeposit(fromAddress, toAddress, l2Token),
          eventConfig
        );

    return {
      [l2Token]: events.map((event) => processEvent(event, "_amount", "_to", "l1Sender")),
    };
  }

  _secondBridgeCalldata(toAddress: string, l1Token: string, amount: BigNumber): string {
    return ethers.utils.defaultAbiCoder.encode(["address", "uint256", "address"], [l1Token, amount, toAddress]);
  }

  async _txBaseCost(): Promise<BigNumber> {
    const l1GasPriceData = await gasPriceOracle.getGasPriceEstimate(this.getL1Bridge().provider!);

    // Similar to the ZkSyncBridge types, we must calculate the l2 gas cost by querying a system contract. In this case,
    // the system contract to query is the bridge hub contract.
    // @dev We pad the estimated L1 gas price by a small amount so that if there is a gas price increase between the time of estimating the gas price
    // and the time of submitting the transaction, the bridge won't revert due to setting the fee too low. The excess ETH will be refunded to the relayer on L2.
    const estimatedL1GasPrice = l1GasPriceData.maxPriorityFeePerGas
      .add(l1GasPriceData.maxFeePerGas)
      .mul(FEE_SCALER_NUMERATOR)
      .div(FEE_SCALER_DENOMINATOR);
    const l2Gas = await this.getL1Bridge().l2TransactionBaseCost(
      this.l2chainId,
      estimatedL1GasPrice,
      this.l2GasLimit,
      this.gasPerPubdataLimit
    );
    return l2Gas;
  }

  async _isContract(address: string, provider: Provider): Promise<boolean> {
    return isContractDeployedToAddress(address, provider);
  }
}

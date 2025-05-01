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
  EvmAddress,
  isDefined,
  bnZero,
  ZERO_BYTES,
} from "../../utils";
import { processEvent, matchL2EthDepositAndWrapEvents } from "../utils";
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
  readonly nativeTokenVault: Contract;
  // @dev The native and wrapped native token contracts are only used when we are bridging the custom gas token.
  readonly nativeToken: Contract;
  readonly wrappedNativeToken: Contract;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _l1Token: EvmAddress
  ) {
    const { address: sharedBridgeAddress, abi: sharedBridgeAbi } = CONTRACT_ADDRESSES[hubChainId].zkStackSharedBridge;
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [EvmAddress.from(sharedBridgeAddress)]);
    this.sharedBridge = new Contract(sharedBridgeAddress, sharedBridgeAbi, l1Signer);

    const nativeToken = PUBLIC_NETWORKS[l2chainId].nativeToken;
    // Only set nonstandard gas tokens.
    if (nativeToken !== "ETH") {
      this.gasToken = EvmAddress.from(TOKEN_SYMBOLS_MAP[nativeToken].addresses[hubChainId]);

      const { address: nativeTokenAddress, abi: nativeTokenAbi } = CONTRACT_ADDRESSES[l2chainId].nativeToken;
      this.nativeToken = new Contract(nativeTokenAddress, nativeTokenAbi, l2SignerOrProvider);
      const { address: wrappedNativeTokenAddress, abi: wrappedNativeTokenAbi } =
        CONTRACT_ADDRESSES[l2chainId].wrappedNativeToken;
      this.wrappedNativeToken = new Contract(wrappedNativeTokenAddress, wrappedNativeTokenAbi, l2SignerOrProvider);
    }

    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].zkStackBridgeHub;
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);

    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].nativeTokenVault;
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);

    const { address: nativeTokenVaultAddress, abi: nativeTokenVaultAbi } =
      CONTRACT_ADDRESSES[hubChainId].zkStackNativeTokenVault;
    this.nativeTokenVault = new Contract(nativeTokenVaultAddress, nativeTokenVaultAbi, l1Signer);

    // This bridge treats hub pool transfers differently from EOA rebalances, so we must know the hub pool address.
    const { address: hubPoolAddress, abi: hubPoolAbi } = CONTRACT_ADDRESSES[hubChainId].hubPool;
    this.hubPool = new Contract(hubPoolAddress, hubPoolAbi, l1Signer);
  }

  async constructL1ToL2Txn(
    toAddress: EvmAddress,
    l1Token: EvmAddress,
    l2Token: EvmAddress,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    // The zkStack bridges need to know the l2 gas price bid beforehand. If this bid is too small, the transaction will revert.
    const txBaseCost = await this._txBaseCost();
    const secondBridgeCalldata = this._secondBridgeCalldata(toAddress, l1Token, amount);

    // The method/arguments change depending on whether or not we are bridging the gas token or another ERC20.
    let method, args, value;
    const bridgingGasToken = isDefined(this.gasToken) && this.gasToken.eq(l1Token);
    if (bridgingGasToken) {
      method = "requestL2TransactionDirect";
      args = [
        [
          this.l2chainId,
          amount.add(txBaseCost),
          toAddress.toAddress(),
          amount,
          "0x",
          this.l2GasLimit,
          this.gasPerPubdataLimit,
          [],
          toAddress, // Using toAddress as the refund address is safe since this is an EOA transaction.
        ],
      ];
      value = bnZero;
    } else {
      method = "requestL2TransactionTwoBridges";
      args = [
        [
          this.l2chainId,
          txBaseCost,
          0,
          this.l2GasLimit,
          this.gasPerPubdataLimit,
          toAddress.toAddress(),
          this.sharedBridge.address,
          0,
          secondBridgeCalldata,
        ],
      ];
      value = isDefined(this.gasToken) ? bnZero : txBaseCost;
    }

    return {
      contract: this.getL1Bridge(),
      method,
      args,
      value,
    };
  }

  async queryL1BridgeInitiationEvents(
    l1Token: EvmAddress,
    fromAddress: EvmAddress,
    toAddress: EvmAddress,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // Logic changes based on whether we are sending tokens to the spoke pool or to an EOA.
    const isL2Contract = await this._isContract(toAddress.toAddress(), this.getL2Bridge().provider!);
    const annotatedFromAddress = isL2Contract ? this.hubPool.address : fromAddress.toAddress();
    const bridgingCustomGasToken = isDefined(this.gasToken) && this.gasToken.eq(l1Token);
    let processedEvents;
    if (!bridgingCustomGasToken) {
      const assetId = await this.nativeTokenVault.assetId(l1Token.toAddress());
      if (assetId === ZERO_BYTES) {
        throw new Error(`Undefined assetId for L1 token ${l1Token}`);
      }
      const rawEvents = await paginatedEventQuery(
        this.nativeTokenVault,
        this.nativeTokenVault.filters.BridgeBurn(this.l2chainId, assetId, annotatedFromAddress),
        eventConfig
      );
      processedEvents = rawEvents
        .filter((event) => compareAddressesSimple(event.args.receiver, toAddress.toAddress()))
        .map((e) => processEvent(e, "amount"));
    } else {
      if (isL2Contract) {
        const rawEvents = await paginatedEventQuery(this.hubPool, this.hubPool.filters.TokensRelayed(), eventConfig);
        processedEvents = rawEvents
          .filter(
            (e) =>
              compareAddressesSimple(e.args.to, toAddress.toAddress()) &&
              compareAddressesSimple(e.args.l1Token, l1Token.toAddress())
          )
          .map((e) => processEvent(e, "amount"));
      } else if (toAddress.toAddress() === this.hubPool.address) {
        // If the recipient is not an L2 contract, then we should ignore any events where the sender is the HubPool,
        // because the only deposits that we care about that send to a contract are from the HubPool, and we're
        // already tracking that above in the `isL2Contract` case. This case is important because we know the monitor
        // might set the from and to addresses to the same address, and we don't want to double count Hub->Spoke
        // transfers.
        processedEvents = [];
      } else {
        const rawEvents = await paginatedEventQuery(
          this.sharedBridge,
          this.sharedBridge.filters.BridgehubDepositBaseTokenInitiated(this.l2chainId, annotatedFromAddress),
          eventConfig
        );
        processedEvents = rawEvents.map((e) => processEvent(e, "amount"));
      }
    }
    return {
      [this.resolveL2TokenAddress(l1Token)]: processedEvents,
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: EvmAddress,
    fromAddress: EvmAddress,
    toAddress: EvmAddress,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const l2Token = this.resolveL2TokenAddress(l1Token);
    // Similar to the query, if we are sending to the spoke pool, we must assume that the sender is the hubPool,
    // so we add a special case for this reason.
    const isSpokePool = await isContractDeployedToAddress(toAddress.toAddress(), this.l2Bridge.provider);
    const bridgingCustomGasToken = isDefined(this.gasToken) && this.gasToken.eq(l1Token);
    let processedEvents;
    if (!bridgingCustomGasToken) {
      const assetId = await this.getL2Bridge().assetId(l2Token);
      if (assetId === ZERO_BYTES) {
        throw new Error(`Undefined assetId for L2 token ${l2Token}`);
      }
      const events = await paginatedEventQuery(
        this.getL2Bridge(),
        this.getL2Bridge().filters.BridgeMint(this.hubChainId, assetId),
        eventConfig
      );
      processedEvents = events
        .filter((event) => compareAddressesSimple(event.args.receiver, toAddress.toAddress()))
        .map((event) => processEvent(event, "amount"));
    } else {
      // We are bridging the native token so we need to query transfer events from the aliased senders.
      let events;
      if (isSpokePool) {
        events = await paginatedEventQuery(
          this.nativeToken,
          this.nativeToken.filters.Transfer(zksync.utils.applyL1ToL2Alias(this.hubPool.address), toAddress.toAddress()),
          eventConfig
        );
      } else {
        // The transaction originated from the atomic depositor and the L2 does not use a custom gas token.
        const [_events, wrapEvents] = await Promise.all([
          paginatedEventQuery(
            this.nativeToken,
            this.nativeToken.filters.Transfer(fromAddress.toAddress(), toAddress.toAddress()),
            eventConfig
          ),
          paginatedEventQuery(
            this.wrappedNativeToken,
            this.wrappedNativeToken.filters.Deposit(toAddress.toAddress()),
            eventConfig
          ),
        ]);
        events = matchL2EthDepositAndWrapEvents(_events, wrapEvents);
      }
      processedEvents = events.map((e) => processEvent(e, "_amount"));
    }
    return {
      [l2Token]: processedEvents,
    };
  }

  _secondBridgeCalldata(toAddress: EvmAddress, l1Token: EvmAddress, amount: BigNumber): string {
    return ethers.utils.defaultAbiCoder.encode(
      ["address", "uint256", "address"],
      [l1Token.toAddress(), amount, toAddress.toAddress()]
    );
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

  protected override resolveL2TokenAddress(l1Token: EvmAddress): string {
    // ZkStack chains may or may not have native USDC, but all will have only one USDC "type" supported by Across. If there is an entry in the TOKEN_SYMBOLS_MAP for USDC, then use this, otherwise, bubble up the resolution.
    if (
      compareAddressesSimple(TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId], l1Token.toAddress()) &&
      isDefined(TOKEN_SYMBOLS_MAP.USDC.addresses[this.l2chainId])
    ) {
      return TOKEN_SYMBOLS_MAP.USDC.addresses[this.l2chainId];
    }
    return super.resolveL2TokenAddress(l1Token);
  }
}

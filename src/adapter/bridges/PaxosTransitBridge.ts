import { Contract, Signer } from "ethers";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import { TokenInfo } from "../../interfaces";
import {
  BigNumber,
  EventSearchConfig,
  Provider,
  assert,
  Address,
  EvmAddress,
  winston,
  getNetworkName,
  CHAIN_IDs,
  paginatedEventQuery,
  getTokenInfo,
  isDefined,
  createPaxosTransitClient,
  getPaxosTransitDestinationToken,
  getPaxosTransitStationAddress,
  getPaxosTransitBoringVaultAddress,
  buildPaxosTransitSubmitOrderTxn,
  PAXOS_TRANSIT_MINIMUMS,
  PaxosTransitClient,
  bnZero,
} from "../../utils";
import { TransferTokenParams, processEvent } from "../utils";
import ERC20_ABI from "../../common/abi/MinimalERC20.json";

export class PaxosTransitBridge extends BaseBridgeAdapter {
  protected client: PaxosTransitClient;
  protected l1TokenInfo: TokenInfo;
  protected l2TokenAddress: string;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l1Token: EvmAddress,
    readonly logger: winston.Logger
  ) {
    assert(hubChainId === CHAIN_IDs.MAINNET, "Paxos Transit bridge only supports mainnet as hub chain");

    super(l2chainId, hubChainId, l1Signer, []);

    const l2TokenAddress = getPaxosTransitDestinationToken(l2chainId, l1Token);
    assert(
      isDefined(l2TokenAddress),
      `No Paxos Transit destination token configured for chain ${l2chainId} and L1 token ${l1Token.toNative()}`
    );

    this.l1Bridge = new Contract(l1Token.toNative(), ERC20_ABI, l1Signer);
    this.l2Bridge = new Contract(l2TokenAddress, ERC20_ABI, l2SignerOrProvider);
    this.client = createPaxosTransitClient(logger);
    this.l1TokenInfo = getTokenInfo(l1Token, this.hubChainId);
    this.l2TokenAddress = l2TokenAddress;
  }

  async constructL1ToL2Txn(
    _toAddress: Address,
    l1Token: EvmAddress,
    l2Token: Address,
    amount: BigNumber,
    _optionalParams?: TransferTokenParams
  ): Promise<BridgeTransactionDetails> {
    assert(
      l2Token.toNative() === this.l2TokenAddress,
      `Attempting to bridge unsupported l2 token ${l2Token.toNative()}`
    );
    assert(l1Token.toNative() === this.l1Bridge?.address, "L1 token mismatch for Paxos Transit bridge");

    if (amount.lt(PAXOS_TRANSIT_MINIMUMS[this.hubChainId]?.[this.l2chainId] ?? bnZero)) {
      throw new Error(`Cannot bridge to ${getNetworkName(this.l2chainId)} due to invalid amount ${amount}`);
    }

    const userAddress = await this.l1Signer.getAddress();
    const orderData = await buildPaxosTransitSubmitOrderTxn(this.client, this.l1Signer, {
      userAddress,
      offerAmount: amount,
      offerAsset: l1Token.toNative(),
      wantAsset: this.l2TokenAddress,
      sourceChainId: this.hubChainId,
      destinationChainId: this.l2chainId,
      spenderAddress: getPaxosTransitStationAddress(this.hubChainId),
    });

    return {
      // @TODO: We should use the actual ABI of the contract. This is just a placeholder.
      contract: new Contract(orderData.transaction.to, [], this.l1Signer),
      method: "",
      args: [orderData.transaction.data],
      value: BigNumber.from(orderData.transaction.value),
    };
  }

  async queryL1BridgeInitiationEvents(
    l1Token: EvmAddress,
    fromAddress: EvmAddress,
    _toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const l1Provider = this.l1Signer.provider;
    assert(isDefined(l1Provider), "PaxosTransitBridge: l1Signer must have a provider");
    const transitStation = getPaxosTransitStationAddress(this.hubChainId);
    const tokenContract = new Contract(l1Token.toNative(), ERC20_ABI, l1Provider);
    const events = await paginatedEventQuery(
      tokenContract,
      tokenContract.filters.Transfer(fromAddress.toNative(), transitStation),
      eventConfig
    );
    return {
      [this.l2TokenAddress]: events.map((event) => processEvent(event, "value")),
    };
  }

  async queryL2BridgeFinalizationEvents(
    _l1Token: EvmAddress,
    _fromAddress: EvmAddress,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    assert(toAddress.isEVM(), "Paxos Transit finalization events require an EVM destination address");
    const l2Provider = this.l2Bridge?.provider;
    assert(isDefined(l2Provider), "PaxosTransitBridge: l2 provider is required");
    const boringVault = getPaxosTransitBoringVaultAddress(this.l2chainId);
    const tokenContract = new Contract(this.l2TokenAddress, ERC20_ABI, l2Provider);
    const events = await paginatedEventQuery(
      tokenContract,
      tokenContract.filters.Transfer(boringVault, toAddress.toNative()),
      eventConfig
    );
    return {
      [this.l2TokenAddress]: events.map((event) => processEvent(event, "value")),
    };
  }
}

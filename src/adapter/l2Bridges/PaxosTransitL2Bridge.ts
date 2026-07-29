import {
  Address,
  BigNumber,
  bnZero,
  Contract,
  EventSearchConfig,
  getNetworkName,
  Signer,
  EvmAddress,
  CHAIN_IDs,
  PAXOS_TRANSIT_MINIMUMS,
  toBN,
  getTokenInfo,
  isDefined,
  assert,
  createPaxosTransitClient,
  getPaxosTransitDestinationToken,
  getPaxosTransitStationAddress,
  buildPaxosTransitSubmitOrderTxn,
  paginatedEventQuery,
  toAddressType,
  PaxosTransitClient,
} from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import { AugmentedTransaction } from "../../clients/TransactionClient";
import { TokenInfo } from "../../interfaces";
import ERC20_ABI from "../../common/abi/MinimalERC20.json";
import { processEvent } from "../utils";

export class PaxosTransitL2Bridge extends BaseL2BridgeAdapter {
  protected client: PaxosTransitClient;
  protected l1TokenInfo: TokenInfo;
  protected l2TokenInfo: TokenInfo;
  protected l2TokenAddress: string;

  constructor(l2chainId: number, hubChainId: number, l2Signer: Signer, l1Signer: Signer, l1Token: EvmAddress) {
    if (hubChainId !== CHAIN_IDs.MAINNET) {
      throw new Error("Cannot define a Paxos Transit bridge for a non-production network");
    }
    super(l2chainId, hubChainId, l2Signer, l1Signer, l1Token);

    const l2TokenAddress = getPaxosTransitDestinationToken(l2chainId, l1Token);
    assert(
      isDefined(l2TokenAddress),
      `No Paxos Transit destination token configured for chain ${l2chainId} and L1 token ${l1Token.toNative()}`
    );

    this.client = createPaxosTransitClient();
    this.l1TokenInfo = getTokenInfo(l1Token, this.hubChainId);
    this.l2TokenAddress = l2TokenAddress;
    this.l2TokenInfo = getTokenInfo(toAddressType(l2TokenAddress, this.l2chainId), this.l2chainId);
    this.l2Bridge = new Contract(l2TokenAddress, ERC20_ABI, l2Signer);
    this.l1Bridge = new Contract(l1Token.toNative(), ERC20_ABI, l1Signer);
  }

  override getL2Token(): Address {
    return toAddressType(this.l2TokenAddress, this.l2chainId);
  }

  async constructWithdrawToL1Txns(
    _toAddress: EvmAddress,
    l2Token: EvmAddress,
    l1Token: EvmAddress,
    amount: BigNumber
  ): Promise<AugmentedTransaction[]> {
    assert(l2Token.toNative() === this.l2TokenAddress, `Unsupported L2 token ${l2Token.toNative()}`);
    assert(l1Token.eq(this.l1Token), `Unsupported L1 token ${l1Token.toNative()}`);

    if (amount.lt(PAXOS_TRANSIT_MINIMUMS[this.l2chainId]?.[this.hubChainId] ?? toBN(Number.MAX_SAFE_INTEGER))) {
      throw new Error(`Cannot bridge to ${getNetworkName(this.hubChainId)} due to invalid amount ${amount}`);
    }

    const { l2Signer } = this;
    assert(isDefined(l2Signer), "PaxosTransitL2Bridge: l2Signer is required");
    const userAddress = await l2Signer.getAddress();
    const orderData = await buildPaxosTransitSubmitOrderTxn(this.client, l2Signer, {
      userAddress,
      offerAmount: amount,
      offerAsset: this.l2TokenAddress,
      wantAsset: this.l1Token.toNative(),
      sourceChainId: this.l2chainId,
      destinationChainId: this.hubChainId,
      spenderAddress: getPaxosTransitStationAddress(this.l2chainId),
    });

    const submitOrderTxn = {
      contract: new Contract(orderData.transaction.to, [], l2Signer),
      method: "",
      chainId: this.l2chainId,
      args: [orderData.transaction.data],
      nonMulticall: true,
      canFailInSimulation: false,
      value: BigNumber.from(orderData.transaction.value),
      message: `🎰 Withdrew ${getNetworkName(this.l2chainId)} ${this.l2TokenInfo.symbol} to L1 via Paxos Transit`,
      mrkdwn: `Submitted Paxos Transit order to withdraw ${amount.toString()} ${this.l2TokenInfo.symbol} from ${getNetworkName(
        this.l2chainId
      )} to mainnet ${this.l1TokenInfo.symbol}`,
    };
    return [submitOrderTxn];
  }

  async getL2PendingWithdrawalAmount(
    l2EventConfig: EventSearchConfig,
    _l1EventConfig: EventSearchConfig,
    fromAddress: EvmAddress,
    l2Token: EvmAddress
  ): Promise<BigNumber> {
    const { l2Signer } = this;
    assert(isDefined(l2Signer), "PaxosTransitL2Bridge: l2Signer is required");
    assert(l2Token.toNative() === this.l2TokenAddress, `Unsupported L2 token ${l2Token.toNative()}`);

    const l2Provider = l2Signer.provider;
    assert(isDefined(l2Provider), "PaxosTransitL2Bridge: l2Signer must have a provider");
    const transitStation = getPaxosTransitStationAddress(this.l2chainId);
    const tokenContract = new Contract(this.l2TokenAddress, ERC20_ABI, l2Provider);
    const events = await paginatedEventQuery(
      tokenContract,
      tokenContract.filters.Transfer(fromAddress.toNative(), transitStation),
      l2EventConfig
    );
    return events.map((event) => processEvent(event, "value")).reduce((acc, event) => acc.add(event.amount), bnZero);
  }
}

import { Contract, Signer } from "ethers";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvent, BridgeEvents } from "./BaseBridgeAdapter";
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
  buildPaxosTransitSubmitOrderTxn,
  PAXOS_TRANSIT_MINIMUMS,
  PaxosTransitClient,
  bnZero,
  mapAsync,
  toAddressType,
  getPaxosTransitQuotedReceiveRedisKey,
  PAXOS_TRANSIT_QUOTED_RECEIVE_TTL_SECONDS,
  listOutstandingPaxosTransitOrders,
  isPaxosTransitOrderOutstanding,
  paxosTransitOrderMatchesRoute,
  getPaxosTransitOutstandingOrderAmountInL1Decimals,
  getPaxosTransitInitiationAmountForOutstandingTransfers,
  stringifyThrownValue,
} from "../../utils";
import { TransferTokenParams, processEvent } from "../utils";
import ERC20_ABI from "../../common/abi/MinimalERC20.json";
import { getRedisCache } from "../../cache/Redis";

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

    const expectedDestinationReceiveAmount = isDefined(orderData.amountOut)
      ? BigNumber.from(orderData.amountOut)
      : undefined;

    return {
      // @TODO: We should use the actual ABI of the contract. This is just a placeholder.
      contract: new Contract(orderData.transaction.to, [], this.l1Signer),
      method: "",
      args: [orderData.transaction.data],
      value: BigNumber.from(orderData.transaction.value),
      expectedDestinationReceiveAmount,
    };
  }

  async recordL1ToL2BridgeInitiation(l1TxnHash: string, expectedDestinationReceiveAmount: BigNumber): Promise<void> {
    const redis = await getRedisCache(this.logger);
    if (!isDefined(redis)) {
      return;
    }
    await redis.set(
      getPaxosTransitQuotedReceiveRedisKey(l1TxnHash),
      expectedDestinationReceiveAmount.toString(),
      PAXOS_TRANSIT_QUOTED_RECEIVE_TTL_SECONDS
    );
  }

  async queryL1BridgeInitiationEvents(
    l1Token: EvmAddress,
    fromAddress: EvmAddress,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    assert(fromAddress.eq(toAddress), "Paxos Transit outstanding orders require matching from/to addresses");
    try {
      return await this.queryL1BridgeInitiationEventsFromApi(l1Token, fromAddress);
    } catch (error) {
      this.logger.warn({
        at: "PaxosTransitBridge#queryL1BridgeInitiationEvents",
        message:
          "Failed to query Paxos Transit outstanding orders from API; falling back to on-chain initiation events",
        error: stringifyThrownValue(error),
      });
      return this.queryL1BridgeInitiationEventsOnChain(l1Token, fromAddress, eventConfig);
    }
  }

  /**
   * Paxos finalizations are reflected in order.remainingAmountDue via the API initiation path.
   * On-chain L2 receipts are omitted to avoid cross-asset contamination when multiple offer assets
   * settle to the same destination token.
   */
  async queryL2BridgeFinalizationEvents(
    _l1Token: EvmAddress,
    _fromAddress: EvmAddress,
    _toAddress: Address,
    _eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    return {
      [this.l2TokenAddress]: [],
    };
  }

  private async queryL1BridgeInitiationEventsFromApi(
    l1Token: EvmAddress,
    userAddress: EvmAddress
  ): Promise<BridgeEvents> {
    const orders = await listOutstandingPaxosTransitOrders(this.client, userAddress.toNative());
    const l2TokenDecimals = getTokenInfo(toAddressType(this.l2TokenAddress, this.l2chainId), this.l2chainId).decimals;
    const l1TokenDecimals = this.l1TokenInfo.decimals;
    const routeParams = {
      offerAsset: l1Token.toNative(),
      wantAsset: this.l2TokenAddress,
      sourceChainId: this.hubChainId,
      destinationChainId: this.l2chainId,
      receiver: userAddress.toNative(),
    };

    const outstandingOrders = orders.filter(
      (order) => paxosTransitOrderMatchesRoute(order, routeParams) && isPaxosTransitOrderOutstanding(order)
    );

    const bridgeEvents: BridgeEvent[] = outstandingOrders.map((order) => ({
      txnRef: order.id,
      blockNumber: 0,
      txnIndex: 0,
      logIndex: 0,
      amount: getPaxosTransitOutstandingOrderAmountInL1Decimals(order, l2TokenDecimals, l1TokenDecimals),
    }));

    this.logger.debug({
      at: "PaxosTransitBridge#queryL1BridgeInitiationEventsFromApi",
      message: "Resolved Paxos Transit outstanding orders from API",
      offerAsset: l1Token.toNative(),
      wantAsset: this.l2TokenAddress,
      outstandingOrderCount: bridgeEvents.length,
      outstandingAmount: bridgeEvents.reduce((acc, event) => acc.add(event.amount), bnZero).toString(),
    });

    return {
      [this.l2TokenAddress]: bridgeEvents,
    };
  }

  private async queryL1BridgeInitiationEventsOnChain(
    l1Token: EvmAddress,
    fromAddress: EvmAddress,
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
    const redis = await getRedisCache(this.logger);
    const l2TokenDecimals = getTokenInfo(toAddressType(this.l2TokenAddress, this.l2chainId), this.l2chainId).decimals;
    const l1TokenDecimals = this.l1TokenInfo.decimals;
    const processedEvents = await mapAsync(events, async (event) => {
      const bridgeEvent = processEvent(event, "value");
      if (!isDefined(redis)) {
        return bridgeEvent;
      }
      const quotedL2Receive = await redis.get<string>(getPaxosTransitQuotedReceiveRedisKey(bridgeEvent.txnRef));
      return {
        ...bridgeEvent,
        amount: getPaxosTransitInitiationAmountForOutstandingTransfers(
          bridgeEvent.amount,
          isDefined(quotedL2Receive) ? BigNumber.from(quotedL2Receive) : undefined,
          l2TokenDecimals,
          l1TokenDecimals
        ),
      };
    });
    return {
      [this.l2TokenAddress]: processedEvents,
    };
  }
}

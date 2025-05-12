import {
  BigNumber,
  Contract,
  Signer,
  Provider,
  EvmAddress,
  assert,
  isDefined,
  ethers,
  paginatedEventQuery,
  Address,
  EventSearchConfig,
  toBytes32,
  bnZero,
  getTranslatedTokenAddress,
  getTokenInfo,
  getNetworkName,
  createFormatFunction,
  getL1TokenAddress,
} from "../../utils";
import { PUBLIC_NETWORKS, HYPERLANE_NO_DOMAIN_ID } from "@across-protocol/constants";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import { processEvent } from "../utils";
import HYPERLANE_ROUTER_ABI from "../../common/abi/IHypXERC20Router.json";
import { HYPERLANE_ROUTERS, DEFAULT_FEE_CAP, FEE_CAP_OVERRIDES } from "../bridges/HyperlaneXERC20Bridge";
import { AugmentedTransaction } from "../../clients/TransactionClient";
import { BridgeEvent } from "../bridges/BaseBridgeAdapter"; // Import BridgeEvent type

export class HyperlaneXERC20BridgeL2 extends BaseL2BridgeAdapter {
  readonly l2Token: EvmAddress;
  private readonly originDomainId: number;
  private readonly destinationDomainId: number;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l2Signer: Signer,
    l1Provider: Provider | Signer,
    l1Token: EvmAddress // This is the token address on the HUB chain (L1)
  ) {
    super(l2chainId, hubChainId, l2Signer, l1Provider, l1Token);

    const l2TokenAddressStr2 = getL1TokenAddress(l1Token.toAddress());

    const l2TokenAddressStr = getTranslatedTokenAddress(l1Token.toAddress(), hubChainId, l2chainId, false);
    this.l2Token = EvmAddress.from(l2TokenAddressStr);

    const l2RouterAddressStr = HYPERLANE_ROUTERS[l2chainId]?.[l2TokenAddressStr.toLowerCase()];
    assert(
      isDefined(l2RouterAddressStr),
      `No L2 Hyperlane router found for token ${l2TokenAddressStr} on chain ${l2chainId}`
    );

    const l1RouterAddressStr = HYPERLANE_ROUTERS[hubChainId]?.[l1Token.toAddress().toLowerCase()];
    assert(
      isDefined(l1RouterAddressStr),
      `No L1 Hyperlane router found for token ${l1Token.toAddress()} on chain ${hubChainId}`
    );

    this.l2Bridge = new Contract(l2RouterAddressStr, HYPERLANE_ROUTER_ABI, l2Signer);
    this.l1Bridge = new Contract(l1RouterAddressStr, HYPERLANE_ROUTER_ABI, l1Provider);

    this.originDomainId = PUBLIC_NETWORKS[l2chainId].hypDomainId;
    assert(
      this.originDomainId != HYPERLANE_NO_DOMAIN_ID,
      `Hyperlane domain id not set for chain ${l2chainId}. Set it first before using HyperlaneXERC20BridgeL2`
    );
    this.destinationDomainId = PUBLIC_NETWORKS[hubChainId].hypDomainId;
    assert(
      this.destinationDomainId != HYPERLANE_NO_DOMAIN_ID,
      `Hyperlane domain id not set for chain ${hubChainId}. Set it first before using HyperlaneXERC20BridgeL2`
    );
  }

  async constructWithdrawToL1Txns(
    toAddress: Address, // L1 recipient
    l2Token: Address,
    _l1Token: EvmAddress, // Ignored, we use this.l1Token from constructor
    amount: BigNumber
  ): Promise<AugmentedTransaction[]> {
    assert(
      this.l2Token.eq(l2Token),
      `this.l2Token does not match l2Token constructWithdrawToL1Txns was called with: ${this.l2Token} != ${l2Token}`
    );

    const fee: BigNumber = await this.l2Bridge.quoteGasPayment(this.destinationDomainId);

    const feeCap = FEE_CAP_OVERRIDES[this.hubChainId] ?? DEFAULT_FEE_CAP;
    if (fee.gt(feeCap)) {
      throw new Error(
        `Hyperlane fee ${ethers.utils.formatEther(fee)} ETH exceeds cap ${ethers.utils.formatEther(
          feeCap
        )} ETH for L1 chain ${this.hubChainId}`
      );
    }

    const { decimals, symbol } = getTokenInfo(l2Token.toAddress(), this.l2chainId);
    const formatter = createFormatFunction(2, 4, false, decimals);

    const withdrawTxn: AugmentedTransaction = {
      contract: this.l2Bridge,
      chainId: this.l2chainId,
      method: "transferRemote",
      args: [this.destinationDomainId, toBytes32(toAddress.toAddress()), amount],
      value: fee,
      message: "🛰️ Withdrew Hyperlane xERC20 to L1",
      mrkdwn: `Withdrew ${formatter(amount.toString())} ${symbol} from ${getNetworkName(
        this.l2chainId
      )} to L1 via Hyperlane`,
    };

    return [withdrawTxn];
  }

  /*
  Retrieves pending L2->L1 withdrawals for a given L1 recipient address.
  It matches SentTransferRemote events on L2 with ReceivedTransferRemote events on L1.
  Matching is done based on recipient and amount, which might be inaccurate if multiple
  transfers of the same amount to the same recipient occur close together.
  */
  async getL2PendingWithdrawalAmount(
    l2EventConfig: EventSearchConfig,
    l1EventConfig: EventSearchConfig,
    fromAddress: Address, // This is the L1 recipient address
    l2Token: Address
  ): Promise<BigNumber> {
    assert(
      this.l2Token.eq(l2Token),
      `this.l2Token does not match l2Token getL2PendingWithdrawalAmount was called with: ${this.l2Token} != ${l2Token}`
    );

    const recipientBytes32 = toBytes32(fromAddress.toAddress());

    const [sentEventsRaw, receivedEventsRaw] = await Promise.all([
      paginatedEventQuery(
        this.l2Bridge,
        this.l2Bridge.filters.SentTransferRemote(this.destinationDomainId, recipientBytes32),
        l2EventConfig
      ),
      paginatedEventQuery(
        this.l1Bridge,
        this.l1Bridge.filters.ReceivedTransferRemote(this.originDomainId, recipientBytes32),
        l1EventConfig
      ),
    ]);

    const sentEvents: BridgeEvent[] = sentEventsRaw.map((event) => processEvent(event, "amount"));
    const receivedEvents: BridgeEvent[] = receivedEventsRaw.map((event) => processEvent(event, "amount"));

    // Create a map of received event amounts for quick lookup
    // Store counts to handle multiple transfers of the same amount
    const receivedAmountsCount: Map<string, number> = receivedEvents.reduce((acc, event) => {
      const amountStr = event.amount.toString();
      acc.set(amountStr, (acc.get(amountStr) ?? 0) + 1);
      return acc;
    }, new Map<string, number>());

    let pendingAmount = bnZero;
    for (const sentEvent of sentEvents) {
      const amountStr = sentEvent.amount.toString();
      const receivedCount = receivedAmountsCount.get(amountStr);

      if (isDefined(receivedCount) && receivedCount > 0) {
        // Found a matching received event, decrement count
        receivedAmountsCount.set(amountStr, receivedCount - 1);
      } else {
        // No matching received event found, add to pending amount
        pendingAmount = pendingAmount.add(sentEvent.amount);
      }
    }

    return pendingAmount;
  }
}

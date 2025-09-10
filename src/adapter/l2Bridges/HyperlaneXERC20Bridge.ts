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
  bnZero,
  getTranslatedTokenAddress,
  getTokenInfo,
  getNetworkName,
  createFormatFunction,
  isContractDeployedToAddress,
} from "../../utils";
import { PUBLIC_NETWORKS, HYPERLANE_NO_DOMAIN_ID } from "@across-protocol/constants";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import HYPERLANE_ROUTER_ABI from "../../common/abi/IHypXERC20Router.json";
import { HYPERLANE_ROUTERS, HYPERLANE_DEFAULT_FEE_CAP, HYPERLANE_FEE_CAP_OVERRIDES } from "../../common";
import { AugmentedTransaction } from "../../clients/TransactionClient";

export class HyperlaneXERC20BridgeL2 extends BaseL2BridgeAdapter {
  readonly l2Token: EvmAddress;
  private readonly originDomainId: number;
  private readonly destinationDomainId: number;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l2Signer: Signer,
    l1Provider: Provider | Signer,
    l1Token: EvmAddress
  ) {
    super(l2chainId, hubChainId, l2Signer, l1Provider, l1Token);

    const l2Token = getTranslatedTokenAddress(l1Token, hubChainId, l2chainId);
    assert(l2Token.isEVM());
    this.l2Token = l2Token;

    const l2RouterAddressStr = HYPERLANE_ROUTERS[l2chainId]?.[l2Token.toNative()];
    assert(
      isDefined(l2RouterAddressStr),
      `No L2 Hyperlane router found for token ${l2Token.toNative()} on chain ${l2chainId}`
    );

    const l1RouterAddressStr = HYPERLANE_ROUTERS[hubChainId]?.[l1Token.toNative()];
    assert(
      isDefined(l1RouterAddressStr),
      `No L1 Hyperlane router found for token ${l1Token.toNative()} on chain ${hubChainId}`
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
    toAddress: Address,
    l2Token: Address,
    _l1Token: EvmAddress,
    amount: BigNumber
  ): Promise<AugmentedTransaction[]> {
    assert(
      this.l2Token.eq(l2Token),
      `this.l2Token does not match l2Token constructWithdrawToL1Txns was called with: ${this.l2Token} != ${l2Token}`
    );

    const { decimals, symbol } = getTokenInfo(l2Token, this.l2chainId);
    const formatter = createFormatFunction(2, 4, false, decimals);

    const fee: BigNumber = await this.l2Bridge.quoteGasPayment(this.destinationDomainId);
    const feeCap = HYPERLANE_FEE_CAP_OVERRIDES[this.l2chainId] ?? HYPERLANE_DEFAULT_FEE_CAP;
    assert(
      fee.lte(feeCap),
      `Hyperlane fee ${ethers.utils.formatEther(fee)} exceeds cap ${ethers.utils.formatEther(
        feeCap
      )} ETH for L2 chain ${this.l2chainId}`
    );

    const withdrawTxn: AugmentedTransaction = {
      contract: this.l2Bridge,
      chainId: this.l2chainId,
      method: "transferRemote",
      unpermissioned: false,
      nonMulticall: true,
      args: [this.destinationDomainId, toAddress.toBytes32(), amount],
      value: fee,
      message: `🎰 Withdrew Hyperlane xERC20 ${symbol} to L1`,
      mrkdwn: `Withdrew ${formatter(amount.toString())} ${symbol} from ${getNetworkName(
        this.l2chainId
      )} to L1 via Hyperlane`,
    };

    return [withdrawTxn];
  }

  async getL2PendingWithdrawalAmount(
    l2EventConfig: EventSearchConfig,
    l1EventConfig: EventSearchConfig,
    fromAddress: Address,
    l2Token: Address
  ): Promise<BigNumber> {
    if (!l2Token.eq(this.l2Token)) {
      return bnZero;
    }

    let recipientBytes32: string;
    const isSpokePool = await isContractDeployedToAddress(fromAddress.toNative(), this.l2Bridge.provider);
    if (isSpokePool) {
      recipientBytes32 = this.hubPoolAddress.toBytes32();
    } else {
      recipientBytes32 = fromAddress.toBytes32();
    }

    const [withdrawalInitiatedEvents, withdrawalFinalizedEvents] = await Promise.all([
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

    const finalizedAmountCounts = new Map<string, number>();
    for (const event of withdrawalFinalizedEvents) {
      const amountStr = event.args.amount.toString();
      finalizedAmountCounts.set(amountStr, (finalizedAmountCounts.get(amountStr) || 0) + 1);
    }

    let outstandingWithdrawalAmount = bnZero;
    for (const event of withdrawalInitiatedEvents) {
      const amountStr = event.args.amount.toString();
      const count = finalizedAmountCounts.get(amountStr);

      if (isDefined(count) && count > 0) {
        finalizedAmountCounts.set(amountStr, count - 1);
      } else {
        outstandingWithdrawalAmount = outstandingWithdrawalAmount.add(event.args.amount);
      }
    }

    return outstandingWithdrawalAmount;
  }

  public override requiredTokenApprovals(): { token: EvmAddress; bridge: EvmAddress }[] {
    return [
      {
        token: this.l2Token,
        bridge: EvmAddress.from(this.l2Bridge.address),
      },
    ];
  }
}

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
  toBN,
  isContractDeployedToAddress,
} from "../../utils";
import { PUBLIC_NETWORKS, HYPERLANE_NO_DOMAIN_ID } from "@across-protocol/constants";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import HYPERLANE_ROUTER_ABI from "../../common/abi/IHypXERC20Router.json";
import { HYPERLANE_ROUTERS, DEFAULT_FEE_CAP, FEE_CAP_OVERRIDES } from "../bridges/HyperlaneXERC20Bridge";
import { AugmentedTransaction } from "../../clients/TransactionClient";
import { CONTRACT_ADDRESSES } from "../../common";
import ERC20_ABI from "../../common/abi/MinimalERC20.json";

export class HyperlaneXERC20BridgeL2 extends BaseL2BridgeAdapter {
  readonly l2Token: EvmAddress;
  private readonly originDomainId: number;
  private readonly destinationDomainId: number;
  private readonly hubPoolAddress: string;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l2Signer: Signer,
    l1Provider: Provider | Signer,
    l1Token: EvmAddress
  ) {
    super(l2chainId, hubChainId, l2Signer, l1Provider, l1Token);

    const l2TokenAddressStr = getTranslatedTokenAddress(l1Token.toAddress(), hubChainId, l2chainId);
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
    this.hubPoolAddress = CONTRACT_ADDRESSES[hubChainId]?.hubPool?.address;
    assert(isDefined(this.hubPoolAddress), `HubPool address not found for hubChainId ${hubChainId}`);
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

    const { decimals, symbol } = getTokenInfo(l2Token.toAddress(), this.l2chainId);
    const formatter = createFormatFunction(2, 4, false, decimals);

    const erc20 = new Contract(l2Token.toAddress(), ERC20_ABI, this.l2Signer);
    const approvalTxn: AugmentedTransaction = {
      contract: erc20,
      chainId: this.l2chainId,
      method: "approve",
      unpermissioned: false,
      nonMulticall: true,
      args: [this.l2Bridge.address, amount],
      message: `✅ Approve Hyperlane ${symbol} for withdrawal`,
      mrkdwn: `Approve ${formatter(amount.toString())} ${symbol} for withdrawal via Hyperlane router ${
        this.l2Bridge.address
      } on ${getNetworkName(this.l2chainId)}`,
    };

    const fee: BigNumber = await this.l2Bridge.quoteGasPayment(this.destinationDomainId);
    const feeCap = FEE_CAP_OVERRIDES[this.l2chainId] ?? DEFAULT_FEE_CAP;
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
      // TODO: `canFailInSimulation` and  `gasLimit` are set for now because of current approval flow (see tx above). If we approve these contracts in advance, we'll be able to remove these constraints
      canFailInSimulation: true,
      gasLimit: BigNumber.from(600000),
      args: [this.destinationDomainId, toBytes32(toAddress.toAddress()), amount],
      value: fee,
      message: `🎰 Withdrew Hyperlane xERC20 ${symbol} to L1`,
      mrkdwn: `Withdrew ${formatter(amount.toString())} ${symbol} from ${getNetworkName(
        this.l2chainId
      )} to L1 via Hyperlane`,
    };

    return [approvalTxn, withdrawTxn];
  }

  async getL2PendingWithdrawalAmount(
    l2EventConfig: EventSearchConfig,
    l1EventConfig: EventSearchConfig,
    fromAddress: Address,
    l2Token: Address
  ): Promise<BigNumber> {
    assert(
      this.l2Token.eq(l2Token),
      `this.l2Token does not match l2Token getL2PendingWithdrawalAmount was called with: ${this.l2Token} != ${l2Token}`
    );

    let recipientBytes32: string;
    const isSpokePool = await isContractDeployedToAddress(fromAddress.toAddress(), this.l2Bridge.provider);
    if (isSpokePool) {
      recipientBytes32 = toBytes32(this.hubPoolAddress);
    } else {
      recipientBytes32 = toBytes32(fromAddress.toAddress());
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

    const withdrawalAmount = withdrawalInitiatedEvents.reduce((totalAmount, event) => {
      const matchingFinalizedEvent = withdrawalFinalizedEvents.find((e) =>
        toBN(e.args.amount.toString()).eq(toBN(event.args.amount.toString()))
      );
      if (!isDefined(matchingFinalizedEvent)) {
        return totalAmount.add(event.args.amount);
      }
      return totalAmount;
    }, bnZero);
    return withdrawalAmount;
  }
}

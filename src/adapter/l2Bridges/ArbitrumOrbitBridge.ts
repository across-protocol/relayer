import { CONTRACT_ADDRESSES, CUSTOM_ARBITRUM_GATEWAYS, DEFAULT_ARBITRUM_GATEWAY } from "../../common";
import {
  BigNumber,
  bnZero,
  Contract,
  createFormatFunction,
  EventSearchConfig,
  getL1TokenAddress,
  getNetworkName,
  isDefined,
  paginatedEventQuery,
  Provider,
  Signer,
  toBN,
  EvmAddress,
  getTokenInfo,
} from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import { AugmentedTransaction } from "../../clients/TransactionClient";
import ARBITRUM_ERC20_GATEWAY_L2_ABI from "../../common/abi/ArbitrumErc20GatewayL2.json";

export class ArbitrumOrbitBridge extends BaseL2BridgeAdapter {
  protected l2GatewayRouter: Contract;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l2Signer: Signer,
    l1Provider: Provider | Signer,
    l1Token: EvmAddress
  ) {
    super(l2chainId, hubChainId, l2Signer, l1Provider, l1Token);

    const { address, abi } = CONTRACT_ADDRESSES[l2chainId].erc20GatewayRouter;
    this.l2GatewayRouter = new Contract(address, abi, l2Signer);

    const { l1: l1Address, l2: l2Address } =
      CUSTOM_ARBITRUM_GATEWAYS[this.l2chainId]?.[l1Token.toAddress()] ?? DEFAULT_ARBITRUM_GATEWAY[this.l2chainId];
    const l2GatewayContract = new Contract(l2Address, ARBITRUM_ERC20_GATEWAY_L2_ABI, this.l2Signer);
    const l1GatewayContractAbi = CONTRACT_ADDRESSES[this.hubChainId][`orbitErc20Gateway_${this.l2chainId}`].abi;
    const l1GatewayContract = new Contract(l1Address, l1GatewayContractAbi, this.l1Provider);
    this.l2Bridge = l2GatewayContract;
    this.l1Bridge = l1GatewayContract;
  }

  constructWithdrawToL1Txns(
    toAddress: EvmAddress,
    l2Token: EvmAddress,
    _l1Token: EvmAddress,
    amount: BigNumber
  ): Promise<AugmentedTransaction[]> {
    const l1Token = getL1TokenAddress(l2Token.toAddress(), this.l2chainId);
    const { decimals, symbol } = getTokenInfo(l2Token.toAddress(), this.l2chainId);
    const formatter = createFormatFunction(2, 4, false, decimals);
    const withdrawTxn: AugmentedTransaction = {
      contract: this.l2GatewayRouter,
      chainId: this.l2chainId,
      method: "outboundTransfer",
      args: [
        l1Token, // l1Token
        toAddress.toAddress(), // to
        amount, // amount
        "0x", // data
      ],
      nonMulticall: true,
      message: "🎰 Withdrew Orbit ERC20 to L1",
      mrkdwn: `Withdrew ${formatter(amount.toString())} ${symbol} from ${getNetworkName(this.l2chainId)} to L1`,
    };
    return Promise.resolve([withdrawTxn]);
  }

  async getL2PendingWithdrawalAmount(
    l2EventConfig: EventSearchConfig,
    l1EventConfig: EventSearchConfig,
    fromAddress: EvmAddress,
    l2Token: EvmAddress
  ): Promise<BigNumber> {
    const l1Token = getL1TokenAddress(l2Token.toAddress(), this.l2chainId);
    const [withdrawalInitiatedEvents, withdrawalFinalizedEvents] = await Promise.all([
      paginatedEventQuery(
        this.l2Bridge,
        this.l2Bridge.filters.WithdrawalInitiated(
          null, // l1Token non-indexed
          fromAddress.toAddress() // from
        ),
        l2EventConfig
      ),
      paginatedEventQuery(
        this.l1Bridge,
        this.l1Bridge.filters.WithdrawalFinalized(
          null, // l1Token non-indexed
          fromAddress.toAddress() // from
        ),
        l1EventConfig
      ),
    ]);
    const withdrawalAmount = withdrawalInitiatedEvents.reduce((totalAmount, event) => {
      if (event.args.l1Token === l1Token) {
        const matchingFinalizedEvent = withdrawalFinalizedEvents.find((e) =>
          toBN(e.args._amount.toString()).eq(toBN(event.args._amount.toString()))
        );
        if (!isDefined(matchingFinalizedEvent)) {
          return totalAmount.add(event.args._amount);
        }
      }
      return totalAmount;
    }, bnZero);
    return withdrawalAmount;
  }
}

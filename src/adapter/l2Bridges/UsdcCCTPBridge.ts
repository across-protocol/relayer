import {
  BigNumber,
  bnZero,
  Contract,
  EventSearchConfig,
  getNetworkName,
  isDefined,
  paginatedEventQuery,
  Provider,
  Signer,
  toBN,
  EvmAddress,
  getCctpTokenMessenger,
  isCctpV2L2ChainId,
  getCctpDomainForChainId,
  TOKEN_SYMBOLS_MAP,
  ethers,
  assert,
  createFormatFunction,
  getTokenInfo,
} from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import { AugmentedTransaction } from "../../clients/TransactionClient";

export class UsdcCCTPBridge extends BaseL2BridgeAdapter {
  private CCTP_MAX_SEND_AMOUNT = toBN(1_000_000_000_000); // 1MM USDC.
  private IS_CCTP_V2 = false;
  private readonly l1UsdcTokenAddress: EvmAddress;
  private readonly l2UsdcTokenAddress: EvmAddress;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l2Signer: Signer,
    l1Provider: Provider | Signer,
    l1Token: EvmAddress
  ) {
    super(l2chainId, hubChainId, l2Signer, l1Provider, l1Token);
    this.IS_CCTP_V2 = isCctpV2L2ChainId(l2chainId);

    const { address: l2TokenMessengerAddress, abi: l2TokenMessengerAbi } = getCctpTokenMessenger(l2chainId, l2chainId);
    this.l2Bridge = new Contract(l2TokenMessengerAddress, l2TokenMessengerAbi, l2Signer);

    const { address: l1TokenMessengerAddress, abi: l1Abi } = getCctpTokenMessenger(l2chainId, hubChainId);
    this.l1Bridge = new Contract(l1TokenMessengerAddress, l1Abi, l1Provider);

    this.l1UsdcTokenAddress = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]);
    this.l2UsdcTokenAddress = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[this.l2chainId]);
  }

  private get l1DestinationDomain(): number {
    return getCctpDomainForChainId(this.hubChainId);
  }

  constructWithdrawToL1Txns(
    toAddress: EvmAddress,
    l2Token: EvmAddress,
    l1Token: EvmAddress,
    amount: BigNumber
  ): Promise<AugmentedTransaction[]> {
    assert(l1Token.eq(this.l1UsdcTokenAddress));
    assert(l2Token.eq(this.l2UsdcTokenAddress));
    const { decimals } = getTokenInfo(l2Token, this.l2chainId);
    const formatter = createFormatFunction(2, 4, false, decimals);

    amount = amount.gt(this.CCTP_MAX_SEND_AMOUNT) ? this.CCTP_MAX_SEND_AMOUNT : amount;
    return Promise.resolve([
      {
        contract: this.l2Bridge,
        chainId: this.l2chainId,
        method: "depositForBurn",
        nonMulticall: true,
        message: "🎰 Withdrew CCTP USDC to L1",
        mrkdwn: `Withdrew ${formatter(amount.toString())} USDC from ${getNetworkName(this.l2chainId)} to L1 via CCTP`,
        args: this.IS_CCTP_V2
          ? [
              amount,
              this.l1DestinationDomain,
              toAddress.toBytes32(),
              this.l2UsdcTokenAddress.toNative(),
              ethers.constants.HashZero, // Anyone can finalize the message on domain when this is set to bytes32(0)
              0, // maxFee set to 0 so this will be a "standard" speed transfer
              2000, // Hardcoded minFinalityThreshold value for standard transfer
            ]
          : [amount, this.l1DestinationDomain, toAddress.toBytes32(), this.l2UsdcTokenAddress.toNative()],
      },
    ]);
  }

  async getL2PendingWithdrawalAmount(
    l2EventConfig: EventSearchConfig,
    l1EventConfig: EventSearchConfig,
    fromAddress: EvmAddress,
    l2Token: EvmAddress
  ): Promise<BigNumber> {
    if (!l2Token.eq(this.l2UsdcTokenAddress)) {
      return bnZero;
    }

    const l2EventFilterArgs = this.IS_CCTP_V2
      ? [this.l2UsdcTokenAddress.toNative(), undefined, fromAddress.toNative()]
      : [undefined, this.l2UsdcTokenAddress.toNative(), undefined, fromAddress.toNative()];
    // @dev: First parameter in MintAndWithdraw is mintRecipient, this should be the same as the fromAddress
    // for all use cases of this adapter.
    const l1EventFilterArgs = [fromAddress.toNative(), undefined, this.l1UsdcTokenAddress.toNative()];
    const [withdrawalInitiatedEvents, withdrawalFinalizedEvents] = await Promise.all([
      paginatedEventQuery(this.l2Bridge, this.l2Bridge.filters.DepositForBurn(...l2EventFilterArgs), l2EventConfig),
      paginatedEventQuery(this.l1Bridge, this.l1Bridge.filters.MintAndWithdraw(...l1EventFilterArgs), l1EventConfig),
    ]);
    const counted = new Set<number>();
    const withdrawalAmount = withdrawalInitiatedEvents.reduce((totalAmount, { args: l2Args }) => {
      const matchingFinalizedEvent = withdrawalFinalizedEvents.find(({ args: l1Args }, idx) => {
        // Protect against double-counting the same l1 withdrawal events.
        // @dev: If we begin to send "fast-finalized" messages via CCTP V2 then the amounts will not exactly match
        // and we will need to adjust this logic.
        if (counted.has(idx) || !toBN(l1Args.amount.toString()).eq(toBN(l2Args.amount.toString()))) {
          return false;
        }

        counted.add(idx);
        return true;
      });
      return isDefined(matchingFinalizedEvent) ? totalAmount : totalAmount.add(l2Args.amount);
    }, bnZero);
    return withdrawalAmount;
  }

  public override requiredTokenApprovals(): { token: EvmAddress; bridge: EvmAddress }[] {
    return [
      {
        token: this.l2UsdcTokenAddress,
        bridge: EvmAddress.from(this.l2Bridge.address),
      },
    ];
  }
}

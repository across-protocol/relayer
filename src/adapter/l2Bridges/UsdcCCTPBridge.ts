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
  getV2DepositForBurnMaxFee,
  CCTPV2_FINALITY_THRESHOLD_STANDARD,
} from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import { AugmentedTransaction } from "../../clients/TransactionClient";
import { CCTP_MAX_SEND_AMOUNT } from "../../common";
import { TransferTokenParams } from "../utils";

export class UsdcCCTPBridge extends BaseL2BridgeAdapter {
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

  async constructWithdrawToL1Txns(
    toAddress: EvmAddress,
    l2Token: EvmAddress,
    l1Token: EvmAddress,
    amount: BigNumber,
    optionalParams?: TransferTokenParams
  ): Promise<AugmentedTransaction[]> {
    assert(l1Token.eq(this.l1UsdcTokenAddress));
    assert(l2Token.eq(this.l2UsdcTokenAddress));
    const { decimals } = getTokenInfo(l2Token, this.l2chainId);
    const formatter = createFormatFunction(2, 4, false, decimals);

    amount = amount.gt(CCTP_MAX_SEND_AMOUNT) ? CCTP_MAX_SEND_AMOUNT : amount;
    if (this.IS_CCTP_V2) {
      let maxFee = bnZero,
        finalityThreshold = CCTPV2_FINALITY_THRESHOLD_STANDARD;
      if (optionalParams?.fastMode) {
        ({ maxFee, finalityThreshold } = await this._getCctpV2DepositForBurnMaxFee(amount));
      }
      const adjustedAmount = amount.add(maxFee);
      return Promise.resolve([
        {
          contract: this.l2Bridge,
          chainId: this.l2chainId,
          method: "depositForBurn",
          nonMulticall: true,
          message: `🎰 Withdrew CCTP USDC to L1${optionalParams?.fastMode ? " using fast mode" : ""}`,
          mrkdwn: `Withdrew ${formatter(amount.toString())} USDC from ${getNetworkName(this.l2chainId)} to L1 via CCTP${
            optionalParams?.fastMode ? ` using fast mode with a max fee of ${formatter(maxFee.toString())}` : ""
          }`,
          args: [
            adjustedAmount.gt(CCTP_MAX_SEND_AMOUNT) ? CCTP_MAX_SEND_AMOUNT : adjustedAmount, // Add maxFee so that we end up with desired amount of tokens on destinationchain.
            this.l1DestinationDomain,
            toAddress.toBytes32(),
            this.l2UsdcTokenAddress.toNative(),
            ethers.constants.HashZero, // Anyone can finalize the message on domain when this is set to bytes32(0)
            maxFee,
            finalityThreshold,
          ],
        },
      ]);
    }
    return Promise.resolve([
      {
        contract: this.l2Bridge,
        chainId: this.l2chainId,
        method: "depositForBurn",
        nonMulticall: true,
        message: "🎰 Withdrew CCTP USDC to L1",
        mrkdwn: `Withdrew ${formatter(amount.toString())} USDC from ${getNetworkName(this.l2chainId)} to L1 via CCTP`,
        args: [amount, this.l1DestinationDomain, toAddress.toBytes32(), this.l2UsdcTokenAddress.toNative()],
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
        const l1TotalAmount = this.IS_CCTP_V2
          ? toBN(l1Args.amount.toString()).add(toBN(l1Args.feeCollected.toString()))
          : toBN(l1Args.amount.toString());
        if (counted.has(idx) || !l1TotalAmount.eq(toBN(l2Args.amount.toString()))) {
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

  async _getCctpV2DepositForBurnMaxFee(amount: BigNumber): Promise<{ maxFee: BigNumber; finalityThreshold: number }> {
    return getV2DepositForBurnMaxFee(this.l2UsdcTokenAddress, this.l2chainId, this.hubChainId, amount);
  }
}

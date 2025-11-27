import {
  BigNumber,
  bnZero,
  Contract,
  EventSearchConfig,
  getNetworkName,
  isDefined,
  paginatedEventQuery,
  Signer,
  toBN,
  EvmAddress,
  getCctpDomainForChainId,
  TOKEN_SYMBOLS_MAP,
  ethers,
  assert,
  createFormatFunction,
  getTokenInfo,
  getV2DepositForBurnMaxFee,
  getCctpV2TokenMessenger,
  CCTPV2_FINALITY_THRESHOLD_STANDARD,
} from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import { AugmentedTransaction } from "../../clients/TransactionClient";
import { CCTP_MAX_SEND_AMOUNT } from "../../common";
import { TransferTokenParams } from "../utils";

/**
 * This adapter uses CCTP V2 to bridge USDC between L2's.
 */
export class UsdcCCTPBridge extends BaseL2BridgeAdapter {
  private readonly l1UsdcTokenAddress: EvmAddress;
  private readonly l2UsdcTokenAddress: EvmAddress;
  private readonly l2DstUsdcTokenAddress: EvmAddress;

  constructor(l2chainId: number, hubChainId: number, l2Signer: Signer, l1Signer: Signer, l1Token: EvmAddress, l2dstChainId?: number, l2dstSigner?: Signer) {
    super(l2chainId, hubChainId, l2Signer, l1Signer, l1Token, l2dstChainId, l2dstSigner);

    const { address: l2TokenMessengerAddress, abi: l2TokenMessengerAbi } = getCctpV2TokenMessenger(l2chainId);
    this.l2Bridge = new Contract(l2TokenMessengerAddress, l2TokenMessengerAbi, l2Signer);

    const { address: l1TokenMessengerAddress, abi: l1Abi } = getCctpV2TokenMessenger(hubChainId);
    this.l1Bridge = new Contract(l1TokenMessengerAddress, l1Abi, l1Signer);

    this.l1UsdcTokenAddress = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]);
    this.l2UsdcTokenAddress = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[this.l2chainId]);

    if (isDefined(this.l2dstChainId) && isDefined(this.l2DstSigner)) {
      const { address: l2DstTokenMessengerAddress, abi: l2DstTokenMessengerAbi } = getCctpV2TokenMessenger(this.l2dstChainId);
      this.l2DstBridge = new Contract(l2DstTokenMessengerAddress, l2DstTokenMessengerAbi, this.l2DstSigner);
      this.l2DstUsdcTokenAddress = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[this.l2dstChainId]);
    }
  }

  private get l1DestinationDomain(): number {
    return getCctpDomainForChainId(this.hubChainId);
  }

  private get l2DstDestinationDomain(): number {
    assert(isDefined(this.l2dstChainId), "Destination L2 chain must be configured");
    return getCctpDomainForChainId(this.l2dstChainId);
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
    let maxFee = bnZero,
      finalityThreshold = CCTPV2_FINALITY_THRESHOLD_STANDARD;
    if (optionalParams?.fastMode) {
      ({ maxFee, finalityThreshold } = await this._getCctpV2DepositForBurnMaxFee(amount));
    }
    // Add maxFee so that we end up with desired amount of tokens on destination chain.
    const amountWithFee = amount.add(maxFee);
    const amountToSend = amountWithFee.gt(CCTP_MAX_SEND_AMOUNT) ? CCTP_MAX_SEND_AMOUNT : amountWithFee;
    return Promise.resolve([
      {
        contract: this.l2Bridge,
        chainId: this.l2chainId,
        method: "depositForBurn",
        nonMulticall: true,
        message: `🎰 Withdrew CCTP USDC to L1${optionalParams?.fastMode ? " using fast mode" : ""}`,
        mrkdwn: `Withdrew ${formatter(amountToSend)} USDC from ${getNetworkName(this.l2chainId)} to L1 via CCTP${
          optionalParams?.fastMode ? ` using fast mode with a max fee of ${formatter(maxFee)}` : ""
        }`,
        args: [
          amountToSend,
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

  /**
   * Constructs a transaction to send USDC from this L2 chain to another L2 chain via CCTP.
   * This is similar to L2->L1 transfers, but uses the destination L2's CCTP domain instead of L1's.
   * The destination L2 chain must be configured in the constructor via l2dstChainId and l2dstSigner.
   *
   * @param toAddress Recipient address on the destination L2 chain
   * @param l2SrcToken Source L2 token address (should be USDC on this chain)
   * @param l2DstToken Destination L2 token address (should be USDC on this chain)
   * @param amount Amount to transfer
   * @param optionalParams Optional parameters including fastMode
   * @returns Array of augmented transactions
   */
  async constructL2ToL2Txn(
    toAddress: EvmAddress,
    l2SrcToken: EvmAddress,
    l2DstToken: EvmAddress,
    amount: BigNumber,
    optionalParams?: TransferTokenParams
  ): Promise<AugmentedTransaction[]> {
    assert(
      isDefined(this.l2dstChainId) && isDefined(this.l2DstSigner),
      "Destination L2 chain must be configured in constructor (l2dstChainId and l2dstSigner)"
    );
    assert(l2SrcToken.eq(this.l2UsdcTokenAddress), "Source token must be USDC on source L2 chain");
    assert(l2DstToken.eq(this.l2DstUsdcTokenAddress), "Destination token must be USDC on destination L2 chain");
    assert(
      this.l2dstChainId !== this.l2chainId,
      "Source and destination chains must be different"
    );
    assert(
      this.l2dstChainId !== this.hubChainId,
      "Use constructWithdrawToL1Txns for L2->L1 transfers"
    );

    const { decimals } = getTokenInfo(l2SrcToken, this.l2chainId);
    const formatter = createFormatFunction(2, 4, false, decimals);

    amount = amount.gt(CCTP_MAX_SEND_AMOUNT) ? CCTP_MAX_SEND_AMOUNT : amount;
    let maxFee = bnZero,
      finalityThreshold = CCTPV2_FINALITY_THRESHOLD_STANDARD;
    if (optionalParams?.fastMode) {
      // For L2->L2, we need to calculate fees based on source and destination L2 chains
      ({ maxFee, finalityThreshold } = await this._getCctpV2DepositForBurnMaxFeeL2ToL2(amount));
    }
    // Add maxFee so that we end up with desired amount of tokens on destination chain.
    const amountWithFee = amount.add(maxFee);
    const amountToSend = amountWithFee.gt(CCTP_MAX_SEND_AMOUNT) ? CCTP_MAX_SEND_AMOUNT : amountWithFee;

    const sourceChainName = getNetworkName(this.l2chainId);
    const destinationChainName = getNetworkName(this.l2dstChainId!);

    return Promise.resolve([
      {
        contract: this.l2Bridge,
        chainId: this.l2chainId,
        method: "depositForBurn",
        nonMulticall: true,
        message: `🎰 Bridged CCTP USDC from ${sourceChainName} to ${destinationChainName}${
          optionalParams?.fastMode ? " using fast mode" : ""
        }`,
        mrkdwn: `Bridged ${formatter(amountToSend)} USDC from ${sourceChainName} to ${destinationChainName} via CCTP${
          optionalParams?.fastMode ? ` using fast mode with a max fee of ${formatter(maxFee)}` : ""
        }`,
        args: [
          amountToSend,
          this.l2DstDestinationDomain,
          toAddress.toBytes32(),
          this.l2UsdcTokenAddress.toNative(),
          ethers.constants.HashZero, // Anyone can finalize the message on domain when this is set to bytes32(0)
          maxFee,
          finalityThreshold,
        ],
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

    const l2EventFilterArgs = [this.l2UsdcTokenAddress.toNative(), undefined, fromAddress.toNative()];
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
        const l1TotalAmount = toBN(l1Args.amount.toString()).add(toBN(l1Args.feeCollected.toString()));
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

  /**
   * Get max fee for L2->L2 CCTP transfers.
   * Uses the same fee calculation as L2->L1, but with destination L2 chain instead of L1.
   */
  async _getCctpV2DepositForBurnMaxFeeL2ToL2(
    amount: BigNumber
  ): Promise<{ maxFee: BigNumber; finalityThreshold: number }> {
    assert(
      isDefined(this.l2dstChainId),
      "Destination L2 chain must be configured in constructor"
    );
    return getV2DepositForBurnMaxFee(this.l2UsdcTokenAddress, this.l2chainId, this.l2dstChainId, amount);
  }
}

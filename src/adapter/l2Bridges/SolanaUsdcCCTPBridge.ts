import {
  BigNumber,
  bnZero,
  Contract,
  EventSearchConfig,
  paginatedEventQuery,
  Signer,
  EvmAddress,
  getCctpDomainForChainId,
  TOKEN_SYMBOLS_MAP,
  assert,
  getCctpV1TokenMessenger,
  getCctpV1MessageTransmitter,
  SvmAddress,
  getAssociatedTokenAddress,
  getKitKeypairFromEvmSigner,
  getCCTPDepositAccounts,
  SVMProvider,
  createDefaultTransaction,
  isDefined,
} from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import { AugmentedTransaction } from "../../clients/TransactionClient";
import { CCTP_MAX_SEND_AMOUNT } from "../../common";
import { arch } from "@across-protocol/sdk";
import { TokenMessengerMinterIdl, TokenMessengerMinterClient } from "@across-protocol/contracts";
import {
  Address,
  generateKeyPairSigner,
  address,
  appendTransactionMessageInstruction,
  pipe,
  type KeyPairSigner,
} from "@solana/kit";

export class SolanaUsdcCCTPBridge extends BaseL2BridgeAdapter {
  private IS_CCTP_V2 = false;
  private readonly l1UsdcTokenAddress: EvmAddress;
  private readonly l2UsdcTokenAddress: SvmAddress;
  private readonly solanaEventsClientPromise: Promise<arch.svm.SvmCpiEventsClient>;
  private readonly tokenMessengerMinter: Address;
  private readonly messageTransmitter: Address;
  private readonly svmSignerPromise: Promise<KeyPairSigner>;
  private svmSigner: KeyPairSigner;
  private solanaEventsClient: arch.svm.SvmCpiEventsClient;

  constructor(l2chainId: number, hubChainId: number, l2Provider: SVMProvider, l1Signer: Signer, l1Token: EvmAddress) {
    super(l2chainId, hubChainId, l2Provider, l1Signer, l1Token);

    const { address: l1TokenMessengerAddress, abi: l1Abi } = getCctpV1TokenMessenger(hubChainId);
    this.l1Bridge = new Contract(l1TokenMessengerAddress, l1Abi, l1Signer);

    this.l1UsdcTokenAddress = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]);
    this.l2UsdcTokenAddress = SvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[this.l2chainId]);

    const { address: l2TokenMessengerAddress } = getCctpV1TokenMessenger(this.l2chainId);
    const { address: l2MessageTransmitterAddress } = getCctpV1MessageTransmitter(this.l2chainId);

    this.tokenMessengerMinter = address(l2TokenMessengerAddress);
    this.messageTransmitter = address(l2MessageTransmitterAddress);

    this.solanaEventsClientPromise = arch.svm.SvmCpiEventsClient.createFor(
      l2Provider,
      this.tokenMessengerMinter,
      TokenMessengerMinterIdl
    );

    this.svmSignerPromise = getKitKeypairFromEvmSigner(this.l1Signer);
  }

  private get l1DestinationDomain(): number {
    return getCctpDomainForChainId(this.hubChainId);
  }

  async constructWithdrawToL1Txns(
    toAddress: EvmAddress,
    l2Token: SvmAddress,
    l1Token: EvmAddress,
    amount: BigNumber
  ): Promise<AugmentedTransaction[]> {
    assert(l1Token.eq(this.l1UsdcTokenAddress));
    assert(l2Token.eq(this.l2UsdcTokenAddress));
    this.svmSigner ??= await this.svmSignerPromise;

    amount = amount.gt(CCTP_MAX_SEND_AMOUNT) ? CCTP_MAX_SEND_AMOUNT : amount;
    const [cctpDepositAccounts, burnTokenAccount, messageSentEventData] = await Promise.all([
      getCCTPDepositAccounts(
        this.hubChainId,
        this.l1DestinationDomain,
        this.tokenMessengerMinter,
        this.messageTransmitter
      ),
      this._getAssociatedTokenAddress(this.svmSigner.address),
      generateKeyPairSigner(),
    ]);
    const {
      tokenMessenger,
      messageTransmitter,
      localToken,
      remoteTokenMessenger,
      tokenMinter,
      cctpEventAuthority: eventAuthority,
      tokenMessengerMinterSenderAuthority: senderAuthorityPda,
    } = cctpDepositAccounts;
    const depositForBurnIx = TokenMessengerMinterClient.getDepositForBurnInstruction({
      owner: this.svmSigner,
      eventRentPayer: this.svmSigner,
      senderAuthorityPda,
      burnTokenAccount,
      messageTransmitter,
      tokenMessenger,
      remoteTokenMessenger,
      tokenMinter,
      localToken,
      burnTokenMint: arch.svm.toAddress(this.l2UsdcTokenAddress),
      messageSentEventData,
      messageTransmitterProgram: this.messageTransmitter,
      tokenMessengerMinterProgram: this.tokenMessengerMinter,
      eventAuthority,
      program: this.tokenMessengerMinter,
      amount: amount.toBigInt(),
      destinationDomain: this.l1DestinationDomain,
      mintRecipient: address(toAddress.toBase58()),
    });
    const depositForBurnTx = pipe(await createDefaultTransaction(this.svmProvider, this.svmSigner), (tx) =>
      appendTransactionMessageInstruction(depositForBurnIx, tx)
    );
    return [depositForBurnTx];
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
    this.svmSigner ??= await this.svmSignerPromise;
    this.solanaEventsClient ??= await this.solanaEventsClientPromise;

    // @dev: First parameter in MintAndWithdraw is mintRecipient, this should be the same as the fromAddress
    // for all use cases of this adapter.
    const l1EventFilterArgs = [fromAddress.toNative(), undefined, this.l1UsdcTokenAddress.toNative()];
    const [withdrawalInitiatedEvents, withdrawalFinalizedEvents] = await Promise.all([
      this.solanaEventsClient.queryDerivedAddressEvents(
        "DepositForBurn",
        this.messageTransmitter,
        BigInt(l2EventConfig.from),
        BigInt(l2EventConfig.to)
      ),
      paginatedEventQuery(this.l1Bridge, this.l1Bridge.filters.MintAndWithdraw(...l1EventFilterArgs), l1EventConfig),
    ]);
    const counted = new Set<number>();
    const withdrawalAmount = withdrawalInitiatedEvents.reduce((totalAmount, l2Args) => {
      const matchingFinalizedEvent = withdrawalFinalizedEvents.find(({ args: l1Args }, idx) => {
        if (counted.has(idx) || !l1Args.amount.eq(l2Args.amount)) {
          return false;
        }
        counted.add(idx);
        return true;
      });
      return isDefined(matchingFinalizedEvent) ? totalAmount : totalAmount.add(l2Args.amount);
    }, bnZero);
    return withdrawalAmount;
  }

  async _getAssociatedTokenAddress(address: Address): Promise<Address> {
    return await getAssociatedTokenAddress(SvmAddress.from(address as string), this.l2UsdcTokenAddress);
  }
}

import { Contract, Signer } from "ethers";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import {
  BigNumber,
  EventSearchConfig,
  TOKEN_SYMBOLS_MAP,
  compareAddressesSimple,
  assert,
  toBN,
  getCctpDomainForChainId,
  Address,
  EvmAddress,
  SvmAddress,
  paginatedEventQuery,
  SVMProvider,
  isDefined,
  getSvmSignerFromEvmSigner,
  getAssociatedTokenAddress,
  winston,
} from "../../utils";
import { processEvent } from "../utils";
import { CCTP_NO_DOMAIN } from "@across-protocol/constants";
import { arch } from "@across-protocol/sdk";
import { TokenMessengerMinterIdl } from "@across-protocol/contracts";
import { CCTP_MAX_SEND_AMOUNT, CONTRACT_ADDRESSES } from "../../common";

type MintAndWithdrawData = {
  mintRecipient: string;
  amount: bigint;
};

export class SolanaUsdcCCTPBridge extends BaseBridgeAdapter {
  private readonly l1UsdcTokenAddress: EvmAddress;
  private readonly l2UsdcTokenAddress: SvmAddress;
  private readonly solanaMessageTransmitter: SvmAddress;
  // We need the constructor to operate in a synchronous context, but the call to construct an event client is asynchronous, so
  // this bridge holds onto the client promise and lazily evaluates it for when it needs to use it (in `queryL2BridgeFinalizationEvents`).
  private readonly solanaEventsClientPromise: Promise<arch.svm.SvmCpiEventsClient>;
  private solanaEventsClient: arch.svm.SvmCpiEventsClient;
  private svmAddress: string;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2Provider: SVMProvider,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _l1Token: EvmAddress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _logger: winston.Logger
  ) {
    // This adapter currently only supports CCTP V1.
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].cctpTokenMessenger;

    super(l2chainId, hubChainId, l1Signer, [EvmAddress.from(l1Address)]);
    assert(
      getCctpDomainForChainId(l2chainId) !== CCTP_NO_DOMAIN && getCctpDomainForChainId(hubChainId) !== CCTP_NO_DOMAIN,
      "Unknown CCTP domain ID"
    );

    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);

    const { address: l2Address } = CONTRACT_ADDRESSES[l2chainId].cctpTokenMessenger;
    this.solanaMessageTransmitter = SvmAddress.from(l2Address);
    this.solanaEventsClientPromise = arch.svm.SvmCpiEventsClient.createFor(
      l2Provider,
      l2Address,
      TokenMessengerMinterIdl
    );
    this.l1UsdcTokenAddress = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]);
    this.l2UsdcTokenAddress = SvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[this.l2chainId]);
  }

  private get l2DestinationDomain(): number {
    return getCctpDomainForChainId(this.l2chainId);
  }

  protected resolveL2TokenAddress(l1Token: EvmAddress): string {
    l1Token;
    return TOKEN_SYMBOLS_MAP.USDC.addresses[this.l2chainId];
  }

  async constructL1ToL2Txn(
    toAddress: Address,
    l1Token: EvmAddress,
    _l2Token: Address,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    assert(compareAddressesSimple(l1Token.toNative(), TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]));
    const signer = await this.l1Signer.getAddress();
    assert(compareAddressesSimple(signer, toAddress.toEvmAddress()), "Cannot rebalance to a non-signer address");
    const associatedTokenAddress = await this._getAssociatedTokenAddress();
    amount = amount.gt(CCTP_MAX_SEND_AMOUNT) ? CCTP_MAX_SEND_AMOUNT : amount;
    return Promise.resolve({
      contract: this.getL1Bridge(),
      method: "depositForBurn",
      args: [amount, this.l2DestinationDomain, associatedTokenAddress.toBytes32(), this.l1UsdcTokenAddress.toNative()],
    });
  }

  async queryL1BridgeInitiationEvents(
    l1Token: EvmAddress,
    fromAddress: EvmAddress,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const signer = await this.l1Signer.getAddress();
    // @todo. We can only track EOA transfers of the signer of the bot since we cannot translate an EVM address to an SVM token account
    // unless we have knowledge of the private key.
    if (fromAddress.toNative() !== signer) {
      return {};
    }
    const associatedTokenAddress = await this._getAssociatedTokenAddress();
    assert(compareAddressesSimple(l1Token.toNative(), TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]));
    const eventFilterArgs = [undefined, this.l1UsdcTokenAddress.toNative(), undefined, fromAddress.toNative()];
    const eventFilter = this.getL1Bridge().filters.DepositForBurn(...eventFilterArgs);
    const events = (await paginatedEventQuery(this.getL1Bridge(), eventFilter, eventConfig)).filter((event) =>
      compareAddressesSimple(event.args.mintRecipient, associatedTokenAddress.toBytes32())
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "amount")),
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: EvmAddress,
    fromAddress: EvmAddress,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const signer = await this.l1Signer.getAddress();
    // @todo. We can only track EOA transfers of the signer of the bot since we cannot translate an EVM address to an SVM token account
    // unless we have knowledge of the private key.
    if (fromAddress.toNative() !== signer) {
      return {};
    }
    const associatedTokenAddress = await this._getAssociatedTokenAddress();

    // Lazily evaluate the events client.
    this.solanaEventsClient ??= await this.solanaEventsClientPromise;
    assert(compareAddressesSimple(l1Token.toNative(), TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]));
    const l2FinalizationEvents = await this.solanaEventsClient.queryDerivedAddressEvents(
      "MintAndWithdraw",
      arch.svm.toAddress(this.solanaMessageTransmitter),
      BigInt(eventConfig.from),
      BigInt(eventConfig.to)
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: l2FinalizationEvents
        .map((event) => {
          const data = event.data as MintAndWithdrawData;
          if (String(data.mintRecipient) !== associatedTokenAddress.toBase58()) {
            return undefined;
          }
          return {
            amount: toBN(data.amount),
            blockNumber: Number(event.slot),
            txnRef: event.signature,
            // There is no log/transaction index on Solana.
            txnIndex: 0,
            logIndex: 0,
          };
        })
        .filter(isDefined),
    };
  }

  async _getAssociatedTokenAddress(): Promise<Address> {
    const svmSigner = getSvmSignerFromEvmSigner(this.l1Signer);
    const associatedTokenAddress = await getAssociatedTokenAddress(
      SvmAddress.from(svmSigner.publicKey.toBase58()),
      this.l2UsdcTokenAddress
    );
    return SvmAddress.from(associatedTokenAddress as string);
  }
}

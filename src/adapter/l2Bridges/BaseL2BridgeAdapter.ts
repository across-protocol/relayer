import { AugmentedTransaction } from "../../clients/TransactionClient";
import {
  BigNumber,
  Contract,
  EventSearchConfig,
  Signer,
  EvmAddress,
  Address,
  getHubPoolAddress,
  getSpokePoolAddress,
  SVMProvider,
  SolanaTransaction,
  isDefined,
} from "../../utils";
import { TransferTokenParams } from "../utils";

export abstract class BaseL2BridgeAdapter {
  protected l2Bridge: Contract;
  protected l1Bridge: Contract;
  protected l2DstBridge: Contract | undefined;
  protected readonly hubPoolAddress: EvmAddress;
  protected readonly spokePoolAddress: Address;
  protected readonly dstSpokePoolAddress: Address | undefined;
  protected readonly l2DstSigner: Signer | undefined;
  protected readonly dstSvmProvider: SVMProvider | undefined;
  // Whether either of these two are defined is determined at construction.
  // The solana bridge defines `svmProvider` while the EVM bridges define `l2Signer`.
  protected readonly l2Signer: Signer | undefined;
  protected readonly svmProvider: SVMProvider | undefined;

  constructor(
    protected l2chainId: number,
    protected hubChainId: number,
    protected l2SignerOrSvmProvider: Signer | SVMProvider,
    protected l1Signer: Signer,
    protected l1Token: EvmAddress,
    protected l2dstChainId?: number,
    protected l2DstSignerOrSvmProvider?: Signer | SVMProvider
  ) {
    this.hubPoolAddress = getHubPoolAddress(hubChainId);
    this.spokePoolAddress = getSpokePoolAddress(l2chainId);
    if (l2SignerOrSvmProvider instanceof Signer) {
      this.l2Signer = l2SignerOrSvmProvider satisfies Signer;
    } else {
      this.svmProvider = l2SignerOrSvmProvider satisfies SVMProvider;
    }

    if (isDefined(l2dstChainId) && isDefined(l2DstSignerOrSvmProvider)) {
      this.dstSpokePoolAddress = getSpokePoolAddress(l2dstChainId);
      if (l2DstSignerOrSvmProvider instanceof Signer) {
        this.l2DstSigner = l2DstSignerOrSvmProvider satisfies Signer;
      } else {
        this.dstSvmProvider = l2DstSignerOrSvmProvider satisfies SVMProvider;
      }
    }
  }

  abstract constructWithdrawToL1Txns(
    toAddress: Address,
    l2Token: Address,
    l1Token: EvmAddress,
    amount: BigNumber,
    optionalParams?: TransferTokenParams
  ): Promise<AugmentedTransaction[] | SolanaTransaction[]>;

  abstract getL2PendingWithdrawalAmount(
    l2EventSearchConfig: EventSearchConfig,
    l1EventSearchConfig: EventSearchConfig,
    fromAddress: Address,
    l2Token: Address
  ): Promise<BigNumber>;

  // Note: Returns `EvmAddress`es since upstream BaseChainAdapter impl. performs evm-style approvals
  // Bridges that require specific approvals should override this method.
  public requiredTokenApprovals(): { token: EvmAddress; bridge: EvmAddress }[] {
    return [];
  }
}

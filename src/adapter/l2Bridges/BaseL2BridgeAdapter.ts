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
import { CctpOftReadOnlyClient, PendingBridgeAdapterName } from "../../rebalancer/clients/CctpOftReadOnlyClient";
import { TransferTokenParams } from "../utils";

const DEFAULT_PENDING_WITHDRAWAL_LOOKBACK_PERIOD_SECONDS = 7200;

export abstract class BaseL2BridgeAdapter {
  protected l2Bridge: Contract;
  protected l1Bridge: Contract;
  protected readonly hubPoolAddress: EvmAddress;
  protected readonly spokePoolAddress: Address;
  protected pendingBridgeRedisReader?: CctpOftReadOnlyClient;
  // Whether either of these two are defined is determined at construction.
  // The solana bridge defines `svmProvider` while the EVM bridges define `l2Signer`.
  protected readonly l2Signer: Signer | undefined;
  protected readonly svmProvider: SVMProvider | undefined;

  constructor(
    protected l2chainId: number,
    protected hubChainId: number,
    protected l2SignerOrSvmProvider: Signer | SVMProvider,
    protected l1Signer: Signer,
    protected l1Token: EvmAddress
  ) {
    this.hubPoolAddress = getHubPoolAddress(hubChainId);
    this.spokePoolAddress = getSpokePoolAddress(l2chainId);
    if (l2SignerOrSvmProvider instanceof Signer) {
      this.l2Signer = l2SignerOrSvmProvider satisfies Signer;
    } else {
      this.svmProvider = l2SignerOrSvmProvider satisfies SVMProvider;
    }
  }

  public pendingWithdrawalLookbackPeriodSeconds(): number {
    return DEFAULT_PENDING_WITHDRAWAL_LOOKBACK_PERIOD_SECONDS;
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

  setPendingBridgeRedisReader(pendingBridgeRedisReader?: CctpOftReadOnlyClient): void {
    this.pendingBridgeRedisReader = pendingBridgeRedisReader;
  }

  getRebalancerPendingBridgeAdapterName(): PendingBridgeAdapterName | undefined {
    return undefined;
  }

  protected isPoolMonitoringAddress(address: Address): boolean {
    return this.hubPoolAddress.eq(address) || this.spokePoolAddress.eq(address);
  }

  protected async getIgnoredPendingBridgeTxnRefs(
    sourceChain: number,
    destinationChain: number,
    address: Address
  ): Promise<Set<string>> {
    if (!isDefined(this.pendingBridgeRedisReader) || this.isPoolMonitoringAddress(address)) {
      return new Set();
    }

    const adapter = this.getRebalancerPendingBridgeAdapterName();
    if (!isDefined(adapter)) {
      return new Set();
    }

    return this.pendingBridgeRedisReader.getPendingBridgeTxnRefsForRoute(
      adapter,
      sourceChain,
      destinationChain,
      EvmAddress.from(address.toNative())
    );
  }
}

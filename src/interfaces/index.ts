import { interfaces } from "@across-protocol/sdk-v2";

export * from "./InventoryManagement";
export * from "./SpokePool";
export * from "./Token";
export * from "./Error";
export * from "./Report";

// Bridge interfaces
export type OutstandingTransfers = interfaces.OutstandingTransfers;

// Common interfaces
export type SortableEvent = interfaces.SortableEvent;
export type BigNumberForToken = interfaces.BigNumberForToken;
export type TreeData<T> = interfaces.TreeData<T>;

// ConfigStore interfaces
export type ParsedTokenConfig = interfaces.ParsedTokenConfig;
export type L1TokenTransferThreshold = interfaces.L1TokenTransferThreshold;
export type SpokePoolTargetBalance = interfaces.SpokePoolTargetBalance;
export type SpokeTargetBalanceUpdate = interfaces.SpokeTargetBalanceUpdate;
export type RouteRateModelUpdate = interfaces.RouteRateModelUpdate;
export type TokenConfig = interfaces.TokenConfig;
export type GlobalConfigUpdate = interfaces.GlobalConfigUpdate;
export type ConfigStoreVersionUpdate = interfaces.ConfigStoreVersionUpdate;
export type DisabledChainsUpdate = interfaces.DisabledChainsUpdate;

// HubPool interfaces
export type PoolRebalanceLeaf = interfaces.PoolRebalanceLeaf;
export type RelayerRefundLeaf = interfaces.RelayerRefundLeaf;
export type ProposedRootBundle = interfaces.ProposedRootBundle;
export type CancelledRootBundle = interfaces.CancelledRootBundle;
export type DisputedRootBundle = interfaces.DisputedRootBundle;
export type ExecutedRootBundle = interfaces.ExecutedRootBundle;
export type RelayerRefundLeafWithGroup = interfaces.RelayerRefundLeafWithGroup;
export type L1Token = interfaces.L1Token;
export type LpToken = interfaces.LpToken;
export type CrossChainContractsSet = interfaces.CrossChainContractsSet;
export type DestinationTokenWithBlock = interfaces.DestinationTokenWithBlock;
export type SetPoolRebalanceRoot = interfaces.SetPoolRebalanceRoot;
export type PendingRootBundle = interfaces.PendingRootBundle;

// SpokePool interfaces
export type FundsDepositedEvent = interfaces.FundsDepositedEvent;
export type Deposit = interfaces.Deposit;
export type DepositWithBlock = interfaces.DepositWithBlock;
export type Fill = interfaces.Fill;
export type FillWithBlock = interfaces.FillWithBlock;
export type SpeedUp = interfaces.SpeedUp;
export type SlowFill = interfaces.SlowFill;
export type RefundRequest = interfaces.RefundRequest;
export type RefundRequestWithBlock = interfaces.RefundRequestWithBlock;
export type RootBundleRelay = interfaces.RootBundleRelay;
export type RootBundleRelayWithBlock = interfaces.RootBundleRelayWithBlock;
export type RelayerRefundExecution = interfaces.RelayerRefundExecution;
export type RelayerRefundExecutionWithBlock = interfaces.RelayerRefundExecutionWithBlock;
export type RelayData = interfaces.RelayData;
export type UnfilledDeposit = interfaces.UnfilledDeposit;
export type UnfilledDepositsForOriginChain = interfaces.UnfilledDepositsForOriginChain;
export type Refund = interfaces.Refund;
export type FillsToRefund = interfaces.FillsToRefund;
export type RunningBalances = interfaces.RunningBalances;
export type TokensBridged = interfaces.TokensBridged;

// UBA interfaces
export type UbaInflow = interfaces.UbaInflow;
export type UbaOutflow = interfaces.UbaOutflow;
export type UbaFlow = interfaces.UbaFlow;

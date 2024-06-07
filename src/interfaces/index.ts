import { BigNumber } from "ethers";
import { interfaces } from "@across-protocol/sdk";

export * from "./InventoryManagement";
export * from "./SpokePool";
export * from "./Token";
export * from "./Error";
export * from "./Report";
export * from "./Arweave";

// Bridge interfaces
export interface OutstandingTransfers {
  [address: string]: {
    [l1Token: string]: {
      [l2Token: string]: {
        totalAmount: BigNumber;
        depositTxHashes: string[];
      };
    };
  };
}

// Common interfaces
export type SortableEvent = interfaces.SortableEvent;
export type BigNumberForToken = interfaces.BigNumberForToken;

// ConfigStore interfaces
export type ParsedTokenConfig = interfaces.ParsedTokenConfig;
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
export type RelayData = interfaces.RelayData;
export type Deposit = interfaces.Deposit;
export type DepositWithBlock = interfaces.DepositWithBlock;
export type Fill = interfaces.Fill;
export type FillWithBlock = interfaces.FillWithBlock;
export type SpeedUp = interfaces.SpeedUp;
export type SlowFillRequest = interfaces.SlowFillRequest;
export type SlowFillRequestWithBlock = interfaces.SlowFillRequestWithBlock;
export type RootBundleRelay = interfaces.RootBundleRelay;
export type RootBundleRelayWithBlock = interfaces.RootBundleRelayWithBlock;
export type RelayerRefundExecution = interfaces.RelayerRefundExecution;
export type RelayerRefundExecutionWithBlock = interfaces.RelayerRefundExecutionWithBlock;
export type Refund = interfaces.Refund;
export type RunningBalances = interfaces.RunningBalances;
export type TokensBridged = interfaces.TokensBridged;
export const { FillType, FillStatus } = interfaces;

export type CachingMechanismInterface = interfaces.CachingMechanismInterface;

// V3 shims (to be removed later)
export type V3RelayData = interfaces.RelayData;
export type V3Deposit = interfaces.Deposit;
export type V3DepositWithBlock = interfaces.DepositWithBlock;
export type V3SpeedUp = interfaces.SpeedUp;
export type V3Fill = interfaces.Fill;
export type V3FillWithBlock = interfaces.FillWithBlock;
export type V3SlowFillLeaf = interfaces.SlowFillLeaf;

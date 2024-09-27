import { BigNumber } from "../utils";

export enum BundleAction {
  PROPOSED = "proposed",
  DISPUTED = "disputed",
  CANCELED = "canceled",
}

export enum BalanceType {
  // Current balance.
  CURRENT = "current",
  // Balance from any pending bundle's refunds.
  PENDING = "pending",
  // Balance from next bundle's refunds.
  NEXT = "next",
  // Balance from pending cross chain transfers.
  PENDING_TRANSFERS = "pending transfers",
  // Total balance across current, pending, next.
  TOTAL = "total",
}

export interface RelayerBalanceCell {
  // This should match BalanceType values. We can't use BalanceType directly because interface only accepts static keys,
  // not those, such as enums, that are determined at runtime.
  [balanceType: string]: BigNumber;
}

export interface RelayerBalanceColumns {
  // Including a column for "Total".
  [chainName: string]: RelayerBalanceCell;
}

// The relayer balance table is organized as below:
// 1. Rows are token symbols, e.g. WETH, USDC
// 2. Columns are chains, e.g. Optimism.
// 3. Each column is further broken into subcolumns: current (live balance), pending (balance from pending bundle's refunds)
//    and next bundle (balance from next bundle's refunds)
export interface RelayerBalanceTable {
  [tokenSymbol: string]: RelayerBalanceColumns;
}

export interface RelayerBalanceReport {
  [relayer: string]: RelayerBalanceTable;
}

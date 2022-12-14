import { BigNumber } from "../utils";
import { SortableEvent } from "./Common";
import { across } from "@uma/sdk";

export interface RateModel {
  UBar: string;
  R0: string;
  R1: string;
  R2: string;
}
export interface ParsedTokenConfig {
  transferThreshold: string;
  rateModel: RateModel;
  routeRateModels?: {
    [path: string]: RateModel;
  };
  spokeTargetBalances?: {
    [chainId: number]: {
      target: string;
      threshold: string;
    };
  };
}

export interface L1TokenTransferThreshold extends SortableEvent {
  transferThreshold: BigNumber;
  l1Token: string;
}

export interface SpokePoolTargetBalance {
  target: BigNumber;
  threshold: BigNumber;
}

export interface SpokeTargetBalanceUpdate extends SortableEvent {
  spokeTargetBalances?: {
    [chainId: number]: SpokePoolTargetBalance;
  };
  l1Token: string;
}

export interface RouteRateModelUpdate extends SortableEvent {
  routeRateModels: {
    [path: string]: string;
  };
  l1Token: string;
}

export interface TokenConfig extends SortableEvent {
  key: string;
  value: string;
}

export interface GlobalConfigUpdate extends SortableEvent {
  value: number;
}

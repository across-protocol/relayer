import { BigNumber } from "ethers";

export interface Deposit {
  depositId: number;
  depositor: string;
  recipient: string;
  originToken: string;
  amount: BigNumber;
  originChainId: number; // appended from chainID in the client.
  destinationChainId: number;
  relayerFeePct: BigNumber;
  quoteTimestamp: number;
  realizedLpFeePct?: BigNumber; // appended after initialization (not part of Deposit event).
  destinationToken?: string; // appended after initialization (not part of Deposit event).
  speedUpSignature?: string | undefined; // appended after initialization, if deposit was speedup (not part of Deposit event).
}
export interface Fill {
  amount: BigNumber;
  totalFilledAmount: BigNumber;
  fillAmount: BigNumber;
  repaymentChainId: number;
  originChainId: number;
  relayerFeePct: BigNumber;
  appliedRelayerFeePct: BigNumber;
  realizedLpFeePct: BigNumber;
  depositId: number;
  destinationToken: string;
  relayer: string;
  depositor: string;
  recipient: string;
  isSlowRelay: boolean;
  destinationChainId: number;
}

export interface SpeedUp {
  depositor: string;
  depositorSignature: string;
  newRelayerFeePct: BigNumber;
  depositId: number;
  originChainId: number;
}

export interface SlowFill {
  relayHash: string;
  amount: BigNumber;
  fillAmount: BigNumber;
  totalFilledAmount: BigNumber;
  originChainId: number;
  relayerFeePct: BigNumber;
  realizedLpFeePct: BigNumber;
  depositId: number;
  destinationToken: string;
  depositor: string;
  recipient: string;
}

// Used in pool by spokePool to execute a slow relay.
export interface RelayData {
  depositor: string;
  recipient: string;
  destinationToken: string;
  amount: BigNumber;
  realizedLpFeePct: BigNumber;
  relayerFeePct: BigNumber;
  depositId: number;
  originChainId: number;
  destinationChainId: number;
}

export interface UnfilledDeposit {
  deposit: Deposit;
  unfilledAmount: BigNumber;
  hasFirstPartialFill?: boolean;
}
export interface FillsToRefund {
  [repaymentChainId: number]: { [l2TokenAddress: string]: Fill[] };
}

import { BigNumber } from "ethers";

export interface Deposit {
  depositId: number;
  depositor: string;
  recipient: string;
  originToken: string;
  amount: BigNumber;
  originChainId: number; // appended from chainID
  destinationChainId: number;
  relayerFeePct: BigNumber;
  quoteTimestamp: number;
  realizedLpFeePct?: BigNumber; // appended after initialization (not part of Deposit event).
  destinationToken?: string; // appended after initialization (not part of Deposit event).
  speedUpSignature?: string | undefined; // appended after initialization, if deposit was speedup (not part of Deposit event).
}
export interface Fill {
  relayHash: string;
  amount: BigNumber;
  totalFilledAmount: BigNumber;
  fillAmount: BigNumber;
  repaymentChainId: number;
  originChainId: number;
  relayerFeePct: BigNumber;
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

export interface UnfilledDeposit {
  deposit: Deposit;
  unfilledAmount: BigNumber;
}
export interface UnfilledDeposits {
  [destinationChainId: number]: UnfilledDeposit[];
}
export interface FillsToRefund {
  [repaymentChainId: number]: { [refundAddress: string]: Fill[] };
}



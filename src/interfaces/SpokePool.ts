import { BigNumber } from "ethers";

export interface Deposit {
  depositId: number;
  depositor: string;
  recipient: string;
  originToken: string;
  amount: BigNumber;
  originChainId: number;
  destinationChainId: number;
  relayerFeePct: BigNumber;
  quoteTimestamp: number;
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

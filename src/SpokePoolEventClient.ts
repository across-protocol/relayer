import { BigNumber, Signer, Contract, ContractFactory } from "ethers";

export interface Deposit {
  depositId: BigNumber;
  depositor: string;
  recipient: string;
  originToken: string;
  amount: BigNumber;
  originChainId: BigNumber;
  destinationChainId: BigNumber;
  relayerFeePct: BigNumber;
  quoteTimestamp: BigNumber;
}
export interface Fill {
  depositId: BigNumber;
  depositor: string;
  relayer: string;
  recipient: string;
  relayHash: string;
  relayAmount: BigNumber;
  fillAmount: BigNumber;
  totalFilledAmount: BigNumber;
  repaymentChainId: BigNumber;
  originChainId: BigNumber;
  destinationChainId: BigNumber;
  relayerFeePct: BigNumber;
  realizedLpFeePct: BigNumber;
  destinationToken: string;
}
export interface SpeedUp {
  depositor: string;
  depositorSignature: string;
  newRelayerFeePct: BigNumber;
  depositId: BigNumber;
}

export interface SlowFill {
  relayHash: string;
  amount: BigNumber;
  fillAmount: BigNumber;
  totalFilledAmount: BigNumber;
  originChainId: BigNumber;
  relayerFeePct: BigNumber;
  realizedLpFeePct: BigNumber;
  depositId: BigNumber;
  destinationToken: string;
  depositor: string;
  recipient: string;
}
export class SpokePoolEventClient {
  constructor(provider: any, startingBlockNumber: any, spokePoolAddress: any) {}

  update() {}
}

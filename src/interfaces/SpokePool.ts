import { SpokePoolClient } from "../clients";
import { BigNumber } from "../utils";

export interface SpokePoolClientsByChain {
  [chainId: number]: SpokePoolClient;
}

export interface ConvertedRelayData {
  depositor: string;
  recipient: string;
  inputToken: string;
  outputToken: string;
  exclusiveRelayer: string;
  originChainId: number;
  depositId: BigNumber;
  inputAmount: BigNumber;
  outputAmount: BigNumber;
  message: string;
  fillDeadline: number;
  exclusivityDeadline: number;
}

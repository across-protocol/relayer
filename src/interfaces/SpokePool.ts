import { SpokePoolClient } from "../clients";
import { RelayData } from "../interfaces";

export interface SpokePoolClientsByChain {
  [chainId: number]: SpokePoolClient;
}

export interface ConvertedRelayData
  extends Omit<RelayData, "depositor" | "recipient" | "inputToken" | "outputToken" | "exclusiveRelayer"> {
  depositor: string;
  recipient: string;
  inputToken: string;
  outputToken: string;
  exclusiveRelayer: string;
}

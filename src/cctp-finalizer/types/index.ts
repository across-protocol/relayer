import type { ContractInterface, ethers } from "ethers";
import type winston from "winston";

export interface ProcessBurnTransactionResponse {
  success: boolean;
  mintTxHash?: string;
  error?: string;
  shouldRetry?: boolean;
}

export interface StringUnion {
  string: string;
}

export interface LongUnion {
  long: number;
}

export interface PubSubMessage {
  burnTransactionHash: string;
  sourceChainId: number;
  message?: StringUnion | null;
  attestation?: StringUnion | null;
  destinationChainId?: LongUnion | null;
  signature?: StringUnion | null;
  quoteDeadline?: LongUnion | null;
}

export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  messageTransmitterAddress: string;
  tokenMessengerAddress: string;
  cctpDomain: number;
}

export type DestinationType = "hypercore" | "lighter" | "direct-evm" | "standard";

export interface DestinationInfo {
  type: DestinationType;
  address: string;
  abi: ContractInterface;
  requiresSignature: boolean;
  accountInitialization?: (
    message: string,
    contract: ethers.Contract,
    chainId: number,
    logger: winston.Logger
  ) => Promise<void>;
}

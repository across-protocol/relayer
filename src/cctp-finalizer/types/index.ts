import type { ethers } from "ethers";
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
}

export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  messageTransmitterAddress: string;
  tokenMessengerAddress: string;
  cctpDomain: number;
}

export type DestinationType = "hypercore" | "lighter" | "standard";

export interface DestinationInfo {
  type: DestinationType;
  address: string;
  abi: unknown[];
  requiresSignature: boolean;
  accountInitialization?: (message: string, signer: ethers.Wallet, logger: winston.Logger) => Promise<void>;
}

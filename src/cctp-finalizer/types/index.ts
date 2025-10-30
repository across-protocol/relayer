export interface ProcessBurnTransactionResponse {
  success: boolean;
  mintTxHash?: string;
  error?: string;
}

export interface PubSubMessage {
  burnTransactionHash: string;
  sourceChainId: number;
  message?: string;
  attestation?: string;
  destinationChainId?: number;
}

export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  messageTransmitterAddress: string;
  tokenMessengerAddress: string;
  cctpDomain: number;
}

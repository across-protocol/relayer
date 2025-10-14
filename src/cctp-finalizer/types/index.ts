export interface CCTPAttestation {
  status: string;
  attestation: string;
  message: string;
  eventNonce: string;
  cctpVersion: number;
}

export interface CCTPAttestationResponse {
  messages: CCTPAttestation[];
}

export interface ProcessBurnTransactionResponse {
  success: boolean;
  mintTxHash?: string;
  error?: string;
}

export interface PubSubMessage {
  burnTransactionHash: string;
  sourceChainId: number;
}

export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  messageTransmitterAddress: string;
  tokenMessengerAddress: string;
  cctpDomain: number;
}

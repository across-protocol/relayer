export interface SwapFlowInitialized {
  quoteNonce: string;
  finalRecipient: string;
  finalToken: string;
  // In baseToken
  evmAmountIn: BigInt;
  bridgingFeesIncurred: BigInt;
  // In finalToken
  coreAmountIn: BigInt;
  minAmountToSend: BigInt;
  maxAmountToSend: BigInt;
}

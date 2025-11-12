import { BigNumber } from "../utils";

export interface SwapFlowInitialized {
  quoteNonce: string;
  finalRecipient: string;
  finalToken: string;
  // In baseToken
  evmAmountIn: BigNumber;
  bridgingFeesIncurred: BigNumber;
  // In finalToken
  coreAmountIn: BigNumber;
  minAmountToSend: BigNumber;
  maxAmountToSend: BigNumber;
}

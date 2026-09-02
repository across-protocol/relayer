import { BigNumber } from "../utils";
import { SortableEvent } from "./";

export interface SwapFlowInitialized extends SortableEvent {
  quoteNonce: string;
  finalRecipient: string;
  finalToken: string;
  // In baseToken, EVM decimals. evmAmountIn is net of bridgingFeesIncurred: only evmAmountIn reaches the
  // swap handler, while minAmountToSend/maxAmountToSend are quoted off evmAmountIn + bridgingFeesIncurred.
  evmAmountIn: BigNumber;
  bridgingFeesIncurred: BigNumber;
  // In baseToken, core decimals: the amount evmAmountIn funded the swap handler with on HyperCore.
  coreAmountIn: BigNumber;
  // In finalToken, core decimals.
  minAmountToSend: BigNumber;
  maxAmountToSend: BigNumber;
}

import { BigNumber } from "../utils";
import { SortableEvent } from "./";

export interface SwapFlowInitialized extends SortableEvent {
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

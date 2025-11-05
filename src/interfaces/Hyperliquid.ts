import { SortableEvent } from "./";
import { BigNumber } from "../utils";

export interface SwapFlowInitialized extends SortableEvent {
  quoteNonce: string;
  inalRecipient: string;
  finalToken: string;
  // In baseToken
  evmAmountIn: BigNumber;
  bridgingFeesIncurred: BigNumber;
  // In finalToken
  coreAmountIn: BigNumber;
  minAmountToSend: BigNumber;
  maxAmountToSend: BigNumber;
}

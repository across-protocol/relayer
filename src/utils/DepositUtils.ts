import { Deposit } from "../interfaces";
import { chainIsEvm } from "./SDKUtils";

// Checks if deposit's .recipient, .outputToken and .exclusiveRelayer are correct for its destinationChainId
export function addrsMatchDstChain(deposit: Deposit): boolean {
  const destinationChainId = deposit.destinationChainId;
  const isEvmChain = chainIsEvm(destinationChainId);

  const addrValidityChecks = [
    isEvmChain ? deposit.recipient.isEVM() : deposit.recipient.isSVM(),
    isEvmChain ? deposit.outputToken.isEVM() : deposit.outputToken.isSVM(),
    deposit.exclusiveRelayer.isZeroAddress()
      ? isEvmChain
        ? deposit.exclusiveRelayer.isEVM()
        : deposit.exclusiveRelayer.isSVM()
      : true,
  ];

  return addrValidityChecks.some((check) => !check);
}

import { RelayData } from "../interfaces";

export function convertRelayDataParamsToBytes32(relayData: RelayData): RelayData {
  return {
    ...relayData,
    depositor: relayData.depositor,
    recipient: relayData.recipient,
    inputToken: relayData.inputToken,
    outputToken: relayData.outputToken,
    exclusiveRelayer: relayData.exclusiveRelayer,
  };
}

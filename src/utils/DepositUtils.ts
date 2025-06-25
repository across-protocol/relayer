import { RelayData, ConvertedRelayData } from "../interfaces";

export function convertRelayDataParamsToBytes32(relayData: RelayData): ConvertedRelayData {
  return {
    ...relayData,
    depositor: relayData.depositor.toBytes32(),
    recipient: relayData.recipient.toBytes32(),
    inputToken: relayData.inputToken.toBytes32(),
    outputToken: relayData.outputToken.toBytes32(),
    exclusiveRelayer: relayData.exclusiveRelayer.toBytes32(),
  };
}

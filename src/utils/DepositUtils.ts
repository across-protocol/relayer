import { RelayData } from "../interfaces";
import { utils } from "@across-protocol/sdk";
const { toBytes32 } = utils;

export function convertRelayDataParamsToBytes32(relayData: RelayData): RelayData {
  return {
    ...relayData,
    depositor: toBytes32(relayData.depositor),
    recipient: toBytes32(relayData.recipient),
    inputToken: toBytes32(relayData.inputToken),
    outputToken: toBytes32(relayData.outputToken),
    exclusiveRelayer: toBytes32(relayData.exclusiveRelayer),
  };
}

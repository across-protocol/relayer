import assert from "assert";
import winston from "winston";
import { clients, relayFeeCalculator } from "@across-protocol/sdk-v2";
import { RefundRequestWithBlock } from "../interfaces";
import { isDefined } from "../utils";
import { HubPoolClient } from "./HubPoolClient";
import { SpokePoolClient } from "./SpokePoolClient";

type RelayFeeCalculatorConfig = relayFeeCalculator.RelayFeeCalculatorConfig;

export class UBAClient extends clients.UBAClient {
  constructor(
    chainIdIndices: number[],
    hubPoolClient: HubPoolClient,
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    logger: winston.Logger
  ) {
    super(chainIdIndices, hubPoolClient, spokePoolClients, {} as RelayFeeCalculatorConfig, logger);
  }

  getRefundRequests(chainId: number, relayer?: string): RefundRequestWithBlock[] {
    const spokePoolClient = this.spokePoolClients[chainId];
    assert(isDefined(spokePoolClient), `Unsupported chainId: ${chainId}`);

    let refundRequests: RefundRequestWithBlock[] = [];
    if (isDefined(relayer)) {
      refundRequests = spokePoolClient
        .getRefundRequests()
        .filter(
          (refundRequest) => relayer === refundRequest.relayer && this.refundRequestIsValid(chainId, refundRequest)
        );
    } else {
      refundRequests = spokePoolClient
        .getRefundRequests()
        .filter((refundRequest) => this.refundRequestIsValid(chainId, refundRequest));
    }

    return refundRequests;
  }
}

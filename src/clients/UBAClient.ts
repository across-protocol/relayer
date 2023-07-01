import winston from "winston";
import { clients, relayFeeCalculator } from "@across-protocol/sdk-v2";
import { FillWithBlock, RefundRequestWithBlock } from "../interfaces";
import { isDefined, queryHistoricalDepositForFill } from "../utils";
import { HubPoolClient } from "./HubPoolClient";
import { SpokePoolClient } from "./SpokePoolClient";

type RelayFeeCalculatorConfig = relayFeeCalculator.RelayFeeCalculatorConfig;

type SpokePoolEventFilter = {
  relayer?: string;
  maxBlockAge?: number;
};

export class UBAClient extends clients.UBAClient {
  constructor(
    chainIdIndices: number[],
    hubPoolClient: HubPoolClient,
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    logger: winston.Logger
  ) {
    super(chainIdIndices, hubPoolClient, spokePoolClients, {} as RelayFeeCalculatorConfig, logger);
  }

  // @description Search for fills recorded by a specific SpokePool.
  // @param chainId Chain ID to search.
  // @param filter  Optional filtering criteria.
  // @returns Array of FillWithBlock events matching the chain ID and optional filtering criteria.
  getFills(chainId: number, filter: SpokePoolEventFilter): FillWithBlock[] {
    const { relayer, maxBlockAge } = filter;

    const fills = this.spokePoolClients[chainId].getFillsForOriginChain(chainId).filter((fill) => {
      const spokePoolClient = this.spokePoolClients[fill.originChainId];

      if (!isDefined(spokePoolClient)) {
        return false;
      }

      if (isDefined(maxBlockAge) && spokePoolClient.latestBlockNumber - fill.blockNumber > maxBlockAge) {
        return false;
      }

      if (isDefined(relayer) && relayer !== fill.relayer) {
        return false;
      }

      // @dev The SDK-v2 UBAClient stores the base SpokePoolClient definition, but here we use an extended variant.
      // This will be resolved when upstreaming to SDK-v2.
      return isDefined(queryHistoricalDepositForFill(spokePoolClient as SpokePoolClient, fill));
    });

    return fills;
  }

  // @description Search for refund requests recorded by a specific SpokePool.
  // @param chainId Chain ID to search.
  // @param filter  Optional filtering criteria.
  // @returns Array of RefundRequestWithBlock events matching the chain ID and optional filtering criteria.
  getRefundRequests(chainId: number, filter: SpokePoolEventFilter = {}): RefundRequestWithBlock[] {
    const { relayer, maxBlockAge } = filter;

    const refundRequests = this.spokePoolClients[chainId].getRefundRequests().filter((refundRequest) => {
      const spokePoolClient = this.spokePoolClients[refundRequest.repaymentChainId];

      if (isDefined(maxBlockAge) ?? spokePoolClient.latestBlockNumber - refundRequest.blockNumber > maxBlockAge) {
        return false;
      }

      if (isDefined(relayer) && relayer !== refundRequest.relayer) {
        return false;
      }

      return this.refundRequestIsValid(chainId, refundRequest);
    });

    return refundRequests;
  }
}

import winston from "winston";
import { clients, relayFeeCalculator } from "@across-protocol/sdk-v2";
import { FillWithBlock, RefundRequestWithBlock } from "../interfaces";
import { isDefined, queryHistoricalDepositForFill } from "../utils";
import { HubPoolClient } from "./HubPoolClient";
import { SpokePoolClient } from "./SpokePoolClient";

type RelayFeeCalculatorConfig = relayFeeCalculator.RelayFeeCalculatorConfig;

type SpokePoolEventFilter = {
  originChainId?: number;
  destinationChainId?: number;
  relayer?: string;
  maxBlockAge?: number;
};

type SpokePoolFillFilter = SpokePoolEventFilter & {
  repaymentChainId?: number;
};

export class UBAClient extends clients.UBAClient {
  constructor(
    chainIdIndices: number[],
    tokenSymbols: string[],
    hubPoolClient: HubPoolClient,
    spokePoolClients: { [chainId: number]: SpokePoolClient },
    logger: winston.Logger,
    maxBundleStates = 1
  ) {
    super(
      chainIdIndices,
      tokenSymbols,
      hubPoolClient,
      spokePoolClients,
      {} as RelayFeeCalculatorConfig,
      maxBundleStates,
      logger
    );
  }

  // @description Search for fills recorded by a specific SpokePool.
  // @param chainId Chain ID to search.
  // @param filter  Optional filtering criteria.
  // @returns Array of FillWithBlock events matching the chain ID and optional filtering criteria.
  getFills(chainId: number, filter: SpokePoolFillFilter = {}): FillWithBlock[] {
    const spokePoolClient = this.spokePoolClients[chainId];
    let fills = spokePoolClient.getFills();
    fills = fills.filter((fill) => {
      if (!isDefined(spokePoolClient)) {
        return false;
      }

      if (isDefined(filter.maxBlockAge) && spokePoolClient.latestBlockNumber - fill.blockNumber > filter.maxBlockAge) {
        return false;
      }

      ["originChainId", "destinationChainId", "repaymentChainId", "relayer"].forEach((field) => {
        if (isDefined(filter[field]) && filter[field] !== fill[field]) {
          return false;
        }
      });

      // @dev The SDK-v2 UBAClient stores the base SpokePoolClient definition, but here we use an extended variant.
      // This will be resolved when upstreaming to SDK-v2.
      const originSpokePoolClient = this.spokePoolClients[fill.originChainId] as SpokePoolClient;
      if (!isDefined(originSpokePoolClient)) {
        return false;
      }
      return isDefined(queryHistoricalDepositForFill(originSpokePoolClient, fill));
    });

    return fills;
  }

  // @description Search for refund requests recorded by a specific SpokePool.
  // @param chainId Chain ID to search.
  // @param filter  Optional filtering criteria.
  // @returns Array of RefundRequestWithBlock events matching the chain ID and optional filtering criteria.
  getRefundRequests(chainId: number, filter: SpokePoolEventFilter = {}): RefundRequestWithBlock[] {
    const { maxBlockAge } = filter;

    const refundRequests = this.spokePoolClients[chainId].getRefundRequests().filter((refundRequest) => {
      const spokePoolClient = this.spokePoolClients[refundRequest.repaymentChainId];

      if (isDefined(maxBlockAge) && spokePoolClient.latestBlockNumber - refundRequest.blockNumber > maxBlockAge) {
        return false;
      }

      ["originChainId", "destinationChainId", "repaymentChainId", "relayer"].forEach((field) => {
        if (isDefined(refundRequest[field]) && filter[field] !== refundRequest[field]) {
          return false;
        }
      });

      return this.refundRequestIsValid(chainId, refundRequest);
    });

    return refundRequests;
  }
}

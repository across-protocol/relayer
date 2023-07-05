import assert from "assert";
import winston from "winston";
import { clients, utils as sdkUtils, relayFeeCalculator } from "@across-protocol/sdk-v2";
import { FillWithBlock, RefundRequestWithBlock } from "../interfaces";
import { isDefined, queryHistoricalDepositForFill } from "../utils";
import { HubPoolClient } from "./HubPoolClient";
import { SpokePoolClient } from "./SpokePoolClient";

const { refundRequestIsValid } = clients;

type RelayFeeCalculatorConfig = relayFeeCalculator.RelayFeeCalculatorConfig;

type SpokePoolEventFilter = {
  originChainId?: number;
  destinationChainId?: number;
  relayer?: string;
  fromBlock?: number;
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
  async getFills(chainId: number, filter: SpokePoolFillFilter = {}): Promise<FillWithBlock[]> {
    const spokePoolClient = this.spokePoolClients[chainId];
    const fills = sdkUtils.filterAsync(spokePoolClient.getFills(), async (fill) => {
      if (!isDefined(spokePoolClient)) {
        return false;
      }

      if (isDefined(filter.fromBlock) && spokePoolClient.latestBlockNumber - fill.blockNumber > filter.fromBlock) {
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

      const deposit = await queryHistoricalDepositForFill(originSpokePoolClient, fill);
      const valid = isDefined(deposit);
      if (!valid) {
        this.logger.debug({ at: "ubaClient::getRefundRequests", message: "Rejected fill", fill });
      }

      return valid;
    });

    return fills;
  }

  // @description Search for refund requests recorded by a specific SpokePool.
  // @param chainId Chain ID to search.
  // @param filter  Optional filtering criteria.
  // @returns Array of RefundRequestWithBlock events matching the chain ID and optional filtering criteria.
  async getRefundRequests(chainId: number, filter: SpokePoolEventFilter = {}): Promise<RefundRequestWithBlock[]> {
    this.logger.debug({
      at: "ubaClient::getRefundRequests",
      message: `Searching for refund requests on chainId ${chainId}`,
    });
    const { fromBlock } = filter;
    const spokePoolClient = this.spokePoolClients[chainId];

    const refundRequests = sdkUtils.filterAsync(spokePoolClient.getRefundRequests(), async (refundRequest) => {
      assert(refundRequest.repaymentChainId === chainId);

      if (isDefined(fromBlock) && spokePoolClient.latestBlockNumber - refundRequest.blockNumber > fromBlock) {
        return false;
      }

      ["originChainId", "destinationChainId", "relayer"].forEach((field) => {
        if (isDefined(refundRequest[field]) && filter[field] !== refundRequest[field]) {
          return false;
        }
      });

      const result = await refundRequestIsValid(
        this.chainIdIndices,
        this.spokePoolClients,
        this.hubPoolClient,
        refundRequest
      );
      if (!result.valid) {
        this.logger.debug({
          at: "ubaClient::getRefundRequests",
          message: `Rejected refund request on chainId ${chainId}`,
          result,
          refundRequest,
        });
      }

      return result.valid;
    });

    return refundRequests;
  }
}

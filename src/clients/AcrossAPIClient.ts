import { winston, BigNumber, getL2TokenAddresses } from "../utils";
import axios, { AxiosError } from "axios";
import { HubPoolClient } from "./HubPoolClient";
import { CHAIN_ID_LIST_INDICES } from "../common";
import { constants } from "@across-protocol/sdk-v2";
import { SpokePoolClientsByChain } from "../interfaces";
import _ from "lodash";
const { TOKEN_SYMBOLS_MAP, CHAIN_IDs } = constants;

export interface DepositLimits {
  maxDeposit: BigNumber;
}

export class AcrossApiClient {
  private endpoint = "https://across.to/api";

  private limits: { [token: string]: BigNumber } = {};

  public updatedLimits = false;

  // Note: Max vercel execution duration is 1 minute
  constructor(
    readonly logger: winston.Logger,
    readonly hubPoolClient: HubPoolClient,
    readonly spokePoolClients: SpokePoolClientsByChain,
    readonly tokensQuery: string[] = [],
    readonly timeout: number = 60000
  ) {
    if (Object.keys(tokensQuery).length === 0) {
      this.tokensQuery = Object.entries(TOKEN_SYMBOLS_MAP).map(([, details]) => details.addresses[CHAIN_IDs.MAINNET]);
    }
  }

  async update(ignoreLimits: boolean): Promise<void> {
    if (ignoreLimits) {
      this.logger.debug({ at: "AcrossAPIClient", message: "Skipping querying /limits" });
      return;
    }

    // Note: Skip tokens not currently enabled in HubPool as we won't be able to relay them.
    if (!this.hubPoolClient.isUpdated) {
      throw new Error("HubPoolClient must be updated before AcrossAPIClient");
    }
    const enabledTokens = this.hubPoolClient.getL1Tokens().map((token) => token.address);
    const tokensQuery = this.tokensQuery.filter((token) => enabledTokens.includes(token));
    this.logger.debug({
      at: "AcrossAPIClient",
      message: "Querying /limits",
      timeout: this.timeout,
      tokensQuery,
      endpoint: this.endpoint,
    });
    this.updatedLimits = false;

    // /limits
    // - Store the max deposit limit for each L1 token. DestinationChainId doesn't matter since HubPool
    // liquidity is shared for all tokens and affects maxDeposit. We don't care about maxDepositInstant
    // when deciding whether a relay will be refunded.
    const mainnetSpokePoolClient = this.spokePoolClients[this.hubPoolClient.chainId];
    if (!mainnetSpokePoolClient.isUpdated) {
      throw new Error("Mainnet SpokePoolClient for chainId must be updated before AcrossAPIClient");
    }
    const data = await Promise.all(
      tokensQuery.map((l1Token) => {
        const l2TokenAddresses = getL2TokenAddresses(l1Token);
        const validDestinationChainForL1Token = Object.keys(l2TokenAddresses).find((chainId) => {
          return (
            mainnetSpokePoolClient.isDepositRouteEnabled(l1Token, Number(chainId)) &&
            Number(chainId) !== CHAIN_IDs.MAINNET &&
            CHAIN_ID_LIST_INDICES.includes(Number(chainId))
          );
        });
        // No valid deposit routes from mainnet for this token. We won't record a limit for it.
        if (validDestinationChainForL1Token === undefined) {
          return undefined;
        }
        return this.callLimits(l1Token, Number(validDestinationChainForL1Token));
      })
    );
    for (let i = 0; i < tokensQuery.length; i++) {
      const resolvedData = data[i];
      if (resolvedData === undefined) {
        this.logger.debug({
          at: "AcrossAPIClient",
          message: "No valid deposit routes for enabled LP token, skipping",
          token: tokensQuery[i],
        });
        continue;
      }
      const l1Token = tokensQuery[i];
      this.limits[l1Token] = resolvedData.maxDeposit;
    }
    this.logger.debug({
      at: "AcrossAPIClient",
      message: "🏁 Fetched max deposit limits",
      limits: this.limits,
    });
    this.updatedLimits = true;
  }

  getLimit(l1Token: string): BigNumber {
    if (!this.limits[l1Token]) {
      throw new Error(`No limit stored for l1Token ${l1Token}`);
    }
    return this.limits[l1Token];
  }

  private async callLimits(
    l1Token: string,
    destinationChainId: number,
    timeout = this.timeout
  ): Promise<DepositLimits> {
    const path = "limits";
    const url = `${this.endpoint}/${path}`;
    const params = { token: l1Token, destinationChainId, originChainId: 1 };

    try {
      const result = await axios(url, { timeout, params });
      return result.data;
    } catch (err) {
      const msg = _.get(err, "response.data", _.get(err, "response.statusText", (err as AxiosError).message));
      this.logger.warn({
        at: "AcrossAPIClient",
        message: "Failed to get /limits, setting limit to 0",
        url,
        params,
        msg,
      });
      return { maxDeposit: BigNumber.from(0) };
    }
  }
}

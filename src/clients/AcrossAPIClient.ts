import _ from "lodash";
import axios, { AxiosError } from "axios";
import {
  bnZero,
  isDefined,
  winston,
  BigNumber,
  getCurrentTime,
  getL2TokenAddresses,
  CHAIN_IDs,
  TOKEN_SYMBOLS_MAP,
  getRedisCache,
  bnUint256Max as uint256Max,
} from "../utils";
import { HubPoolClient } from "./HubPoolClient";

export interface DepositLimits {
  maxDeposit: BigNumber;
}

const API_UPDATE_RETENTION_TIME = 60; // seconds

export class AcrossApiClient {
  private endpoint = "https://app.across.to/api";
  private chainIds: number[];
  private limits: { [token: string]: BigNumber } = {};
  private updatedAt = 0;

  public updatedLimits = false;

  // Note: Max vercel execution duration is 1 minute
  constructor(
    readonly logger: winston.Logger,
    readonly hubPoolClient: HubPoolClient,
    chainIds: number[],
    readonly tokensQuery: string[] = [],
    readonly timeout: number = 3000
  ) {
    if (Object.keys(tokensQuery).length === 0) {
      this.tokensQuery = Object.values(TOKEN_SYMBOLS_MAP).map(({ addresses }) => addresses[CHAIN_IDs.MAINNET]);
    }

    this.chainIds = chainIds.filter((chainId) => chainId !== hubPoolClient.chainId);
  }

  async update(ignoreLimits: boolean): Promise<void> {
    const now = getCurrentTime();
    const updateAge = now - this.updatedAt;
    // If no chainIds are specified, the origin chain is assumed to be the HubPool chain, so skip update.
    if (updateAge < API_UPDATE_RETENTION_TIME || ignoreLimits || this.chainIds.length === 0) {
      this.logger.debug({ at: "AcrossAPIClient", message: "Skipping querying /limits", updateAge });
      return;
    }

    const { hubPoolClient } = this;

    // Note: Skip tokens not currently enabled in HubPool as we won't be able to relay them.
    if (!hubPoolClient.isUpdated) {
      throw new Error("HubPoolClient must be updated before AcrossAPIClient");
    }
    const enabledTokens = hubPoolClient.getL1Tokens().map((token) => token.address);
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
    // Store the max deposit limit for each L1 token. The origin chain can be any supported chain
    // expect the HubPool chain. This assumes the worst-case bridging delay of !mainnet -> mainnet.
    const data = await Promise.all(
      tokensQuery.map((l1Token) => {
        const l2TokenAddresses = getL2TokenAddresses(l1Token);
        const originChainIds = Object.keys(l2TokenAddresses)
          .map(Number)
          .filter((chainId) => {
            try {
              // Verify that a token mapping exists on the origin chain.
              hubPoolClient.getL2TokenForL1TokenAtBlock(l1Token, chainId); // throws if not found.
              return this.chainIds.includes(chainId);
            } catch {
              return false;
            }
          });

        // No valid deposit routes from mainnet for this token. We won't record a limit for it.
        if (originChainIds.length === 0) {
          return undefined;
        }

        return this.callLimits(l1Token, originChainIds);
      })
    );

    tokensQuery.forEach((token, i) => {
      const resolvedData = data[i];
      if (isDefined(resolvedData)) {
        this.limits[token] = data[i].maxDeposit;
      } else {
        this.logger.debug({
          at: "AcrossAPIClient",
          message: "No valid deposit routes for enabled LP token, skipping",
          token,
        });
      }
    });

    this.logger.debug({
      at: "AcrossAPIClient",
      message: "🏁 Fetched max deposit limits",
      limits: this.limits,
    });
    this.updatedLimits = true;
    this.updatedAt = now;
  }

  getLimit(originChainId: number, l1Token: string): BigNumber {
    // Funds can be JIT-bridged from mainnet to anywhere, so don't apply any constraint.
    if (originChainId === this.hubPoolClient.chainId) {
      return uint256Max;
    }

    if (!this.limits[l1Token]) {
      this.logger.warn({
        at: "AcrossApiClient::getLimit",
        message: `No limit stored for l1Token ${l1Token}, defaulting to 0.`,
      });
      return bnZero;
    }
    return this.limits[l1Token];
  }

  getLimitsCacheKey(l1Token: string, originChainId: number): string {
    return `limits_api_${l1Token}_${originChainId}`;
  }

  private async callLimits(l1Token: string, originChainIds: number[], timeout = this.timeout): Promise<DepositLimits> {
    const path = "limits";
    const url = `${this.endpoint}/${path}`;

    const redis = await getRedisCache();

    // Assume worst-case payout on mainnet.
    const destinationChainId = this.hubPoolClient.chainId;
    for (const originChainId of originChainIds) {
      const token = this.hubPoolClient.getL2TokenForL1TokenAtBlock(l1Token, originChainId);
      const params = { token, originChainId, destinationChainId };
      if (redis) {
        try {
          const cachedLimits = await redis.get<string>(this.getLimitsCacheKey(l1Token, originChainId));
          if (cachedLimits !== null) {
            return { maxDeposit: BigNumber.from(cachedLimits) };
          }
        } catch (e) {
          this.logger.debug({
            at: "AcrossAPIClient",
            message: "Failed to get cached limits data",
            l1Token,
            originChainId,
            error: e,
          });
        }
      }
      try {
        const result = await axios(url, { timeout, params });
        if (!result?.data?.maxDeposit) {
          this.logger.error({
            at: "AcrossAPIClient",
            message: "Invalid response from /limits, expected maxDeposit field.",
            url,
            params,
            result,
          });
          continue;
        }
        if (redis) {
          // Cache limit for 5 minutes.
          const baseTtl = 300;
          // Apply a random margin to spread expiry over a larger time window.
          const ttl = baseTtl + Math.ceil(_.random(-0.5, 0.5, true) * baseTtl);
          await redis.set(this.getLimitsCacheKey(l1Token, originChainId), result.data.maxDeposit.toString(), ttl);
        }
        return result.data;
      } catch (err) {
        const msg = _.get(err, "response.data", _.get(err, "response.statusText", (err as AxiosError).message));
        this.logger.warn({
          at: "AcrossAPIClient",
          message: "Failed to get /limits",
          url,
          params,
          msg,
        });
      }
    }

    return { maxDeposit: bnZero };
  }
}

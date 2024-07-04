import _ from "lodash";
import axios, { AxiosError } from "axios";
import {
  bnZero,
  winston,
  BigNumber,
  getCurrentTime,
  TOKEN_SYMBOLS_MAP,
  CHAIN_IDs,
  getRedisCache,
  bnUint256Max as uint256Max,
} from "../utils";
import { HubPoolClient } from "./HubPoolClient";

export interface DepositLimits {
  maxDeposit: BigNumber;
}

const API_UPDATE_RETENTION_TIME = 60; // seconds

export class AcrossApiClient {
  private endpoint: string;
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
    const hubChainId = hubPoolClient.chainId;
    this.endpoint = `https://${hubChainId === CHAIN_IDs.MAINNET ? "app.across.to" : "testnet.across.to"}/api`;
    if (Object.keys(tokensQuery).length === 0) {
      this.tokensQuery = Object.values(TOKEN_SYMBOLS_MAP).map(({ addresses }) => addresses[hubChainId]);
    }

    this.chainIds = chainIds.filter((chainId) => chainId !== hubChainId);
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
    const tokens = this.tokensQuery.filter((token) => enabledTokens.includes(token));
    this.logger.debug({
      at: "AcrossAPIClient",
      message: "Querying /liquid-reserves",
      timeout: this.timeout,
      tokens,
      endpoint: this.endpoint,
    });
    this.updatedLimits = false;

    // /liquid-reserves
    // Store the max available HubPool liquidity (less API-imposed cushioning) for each L1 token.
    const liquidReserves = await this.callLimits(tokens);
    tokens.forEach((token, i) => (this.limits[token] = liquidReserves[i]));

    this.logger.debug({
      at: "AcrossAPIClient",
      message: "🏁 Fetched HubPool liquid reserves",
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
    }
    return this.limits[l1Token] ?? bnZero;
  }

  getLimitsCacheKey(l1Tokens: string[]): string {
    return `limits_api_${l1Tokens.join(",")}`;
  }

  private async callLimits(l1Tokens: string[], timeout = this.timeout): Promise<BigNumber[]> {
    const path = "liquid-reserves";
    const url = `${this.endpoint}/${path}`;

    const redis = await getRedisCache();

    // Assume worst-case payout on mainnet.
    if (redis) {
      try {
        const reserves = await redis.get<string>(this.getLimitsCacheKey(l1Tokens));
        if (reserves !== null) {
          return reserves.split(",").map(BigNumber.from);
        }
      } catch (e) {
        this.logger.debug({ at: "AcrossAPIClient", message: `Failed to get cached ${path} data.`, l1Tokens, error: e });
      }
    }

    const params = { l1Tokens: l1Tokens.join(",") };
    let liquidReserves: BigNumber[] = [];
    try {
      const result = await axios(url, { timeout, params });
      if (!result?.data) {
        this.logger.error({
          at: "AcrossAPIClient",
          message: `Invalid response from /${path}, expected maxDeposit field.`,
          url,
          params,
          result,
        });
      }
      liquidReserves = l1Tokens.map((l1Token) => BigNumber.from(result.data[l1Token] ?? bnZero));
    } catch (err) {
      const msg = _.get(err, "response.data", _.get(err, "response.statusText", (err as AxiosError).message));
      this.logger.warn({ at: "AcrossAPIClient", message: `Failed to get ${path},`, url, params, msg });
      return l1Tokens.map(() => bnZero);
    }

    if (redis) {
      // Cache limit for 5 minutes.
      const baseTtl = 300;
      // Apply a random margin to spread expiry over a larger time window.
      const ttl = baseTtl + Math.ceil(_.random(-0.5, 0.5, true) * baseTtl);
      await redis.set(this.getLimitsCacheKey(l1Tokens), liquidReserves.map((n) => n.toString()).join(","), ttl);
    }

    return liquidReserves;
  }
}

import _ from "lodash";
import axios, { AxiosError } from "axios";
import {
  bnZero,
  winston,
  BigNumber,
  dedupArray,
  getCurrentTime,
  TOKEN_SYMBOLS_MAP,
  CHAIN_IDs,
  getRedisCache,
  bnUint256Max as uint256Max,
} from "../utils";
import { HubPoolClient } from "./HubPoolClient";
import { utils as sdkUtils } from "@across-protocol/sdk";

export interface DepositLimits {
  maxDeposit: BigNumber;
}

const API_UPDATE_RETENTION_TIME = 60; // seconds

export function getAcrossHost(hubChainId: number): string {
  return process.env.ACROSS_API_HOST ?? (hubChainId === CHAIN_IDs.MAINNET ? "app.across.to" : "testnet.across.to");
}

interface GasPrices {
  [chainId: number]: string;
}

export class AcrossApiClient {
  private endpoint: string;
  private chainIds: number[];
  private limits: { [token: string]: BigNumber } = {};
  private gasPrices: GasPrices;
  private updatedAt = 0;
  private profiler: sdkUtils.Profiler;

  public updatedLimits = false;
  public updatedGasPrices = false;

  // Note: Max vercel execution duration is 1 minute
  constructor(
    readonly logger: winston.Logger,
    readonly hubPoolClient: HubPoolClient,
    chainIds: number[],
    readonly tokensQuery: string[] = [],
    readonly timeout: number = 3000
  ) {
    const hubChainId = hubPoolClient.chainId;
    this.endpoint = `https://${getAcrossHost(hubChainId)}/api`;
    if (Object.keys(tokensQuery).length === 0) {
      this.tokensQuery = dedupArray(Object.values(TOKEN_SYMBOLS_MAP).map(({ addresses }) => addresses[hubChainId]));
    }
    this.profiler = new sdkUtils.Profiler({
      at: "AcrossAPIClient",
      logger,
    });

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
    this.updatedLimits = false;
    this.updatedGasPrices = false;
    this.logger.debug({
      at: "AcrossAPIClient",
      message: "Querying Across API",
      timeout: this.timeout,
      endpoint: this.endpoint,
      paths: ["/liquid-reserves", "/gas-prices"],
    });
    const tStart = this.profiler.start("Across API request");
    // TODO: Double timeout for callLimits because its not called on production API which gets its cache warmed.
    const [liquidReserves, gasPrices] = await Promise.all([this.callLimits(tokens), this.callGasPrices(6000)]);
    tStart.stop({
      message: "Completed API requests",
    });
    this.updatedLimits = true;
    this.updatedGasPrices = true;
    this.updatedAt = now;

    // /liquid-reserves
    // Store the max available HubPool liquidity (less API-imposed cushioning) for each L1 token.
    tokens.forEach((token, i) => (this.limits[token] = liquidReserves[i]));
    this.logger.debug({
      at: "AcrossAPIClient",
      message: "🏁 Fetched HubPool liquid reserves",
      limits: this.limits,
    });

    // /gas-prices
    if (Object.keys(gasPrices).length > 0) {
      this.gasPrices = gasPrices;
      this.logger.debug({
        at: "AcrossAPIClient",
        message: "🏁 Fetched gas prices",
        gasPrices: this.gasPrices,
      });
    }
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

  getGasPrice(chainId: number): string | undefined {
    if (!this.gasPrices[chainId]) {
      this.logger.warn({
        at: "AcrossApiClient::gasPrices",
        message: `No gas price stored for chain ${chainId}`,
      });
      return undefined;
    }
    return this.gasPrices[chainId];
  }

  getLimitsCacheKey(l1Tokens: string[]): string {
    return `limits_api_${l1Tokens.join(",")}`;
  }

  getGasPricesCacheKey(): string {
    return "gasprices_api";
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
          message: `Invalid response from /${path}`,
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

  private async callGasPrices(timeout = this.timeout): Promise<GasPrices> {
    const path = "gas-prices";
    // TODO: Change endpoint if live:
    const url = `https://app-frontend-v3-git-gas-prices-api-uma.vercel.app/api/${path}`;

    const redis = await getRedisCache();

    // Assume worst-case payout on mainnet.
    if (redis) {
      try {
        const gasPrices = await redis.get<string>(this.getGasPricesCacheKey());
        if (gasPrices !== null) {
          return JSON.parse(gasPrices);
        }
      } catch (e) {
        this.logger.debug({ at: "AcrossAPIClient", message: `Failed to get cached ${path} data.`, error: e });
      }
    }

    let gasPrices: GasPrices = {};
    try {
      const result = await axios(url, { timeout });
      if (!result?.data) {
        this.logger.error({
          at: "AcrossAPIClient",
          message: `Invalid response from /${path}`,
          url,
          result,
        });
      }
      const chainIds = Object.keys(result.data);
      gasPrices = Object.fromEntries(
        chainIds
          .map((chainId) => [chainId, result.data[chainId] ?? bnZero])
          .filter(([, amount]) => BigNumber.from(amount).gt(0))
      );
    } catch (err) {
      const msg = _.get(err, "response.data", _.get(err, "response.statusText", (err as AxiosError).message));
      this.logger.warn({ at: "AcrossAPIClient", message: `Failed to get ${path},`, url, msg });
      return {};
    }

    if (redis) {
      // Cache gas prices for 1 minute.
      const baseTtl = 60;
      // Apply a random margin to spread expiry over a larger time window.
      const ttl = baseTtl + Math.ceil(_.random(-0.5, 0.5, true) * baseTtl);
      await redis.set(this.getGasPricesCacheKey(), JSON.stringify(gasPrices), ttl);
    }

    return gasPrices;
  }
}

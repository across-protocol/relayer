import { winston, BigNumber, MAX_UINT_VAL } from "../utils";
import { l2TokensToL1TokenValidation } from "../common";
import axios, { AxiosError } from "axios";
import get from "lodash.get";

export interface DepositLimits {
  maxDeposit: BigNumber;
}

export class AcrossApiClient {
  private endpoint = "https://across.to/api";

  private limits: { [token: string]: BigNumber } = {};

  public updatedLimits = false;

  // Note: Max vercel execution duration is 1 minute
  constructor(readonly logger: winston.Logger, readonly tokensQuery: string[] = [], readonly timeout: number = 60000) {
    if (Object.keys(tokensQuery).length === 0) this.tokensQuery = Object.keys(l2TokensToL1TokenValidation);
  }

  async update(ignoreLimits: boolean): Promise<void> {
    if (ignoreLimits) {
      this.logger.debug({ at: "AcrossAPIClient", message: "Skipping querying /limits" });
      return;
    }

    this.logger.debug({
      at: "AcrossAPIClient",
      message: "Querying /limits",
      timeout: this.timeout,
      tokensQuery: this.tokensQuery,
      endpoint: this.endpoint,
    });
    this.updatedLimits = false;

    // /limits
    // - Store the max deposit limit for each L1 token. DestinationChainId doesn't matter since HubPool
    // liquidity is shared for all tokens and affects maxDeposit. We don't care about maxDepositInstant
    // when deciding whether a relay will be refunded.
    const data = await Promise.all(
      this.tokensQuery.map((l1Token) => {
        const validDestinationChainForL1Token = l2TokensToL1TokenValidation[l1Token]
          ? Number(Object.keys(l2TokensToL1TokenValidation[l1Token])[0])
          : 10;
        return this.callLimits(l1Token, validDestinationChainForL1Token);
      })
    );
    for (let i = 0; i < this.tokensQuery.length; i++) {
      const l1Token = this.tokensQuery[i];
      this.limits[l1Token] = data[i].maxDeposit;
    }
    this.logger.debug({
      at: "AcrossAPIClient",
      message: "🏁 Fetched max deposit limits",
      limits: this.limits,
    });
    this.updatedLimits = true;
  }

  getLimit(l1Token: string): BigNumber {
    if (!this.limits[l1Token]) throw new Error(`No limit stored for l1Token ${l1Token}`);
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
      const msg = get(err, "response.data", get(err, "response.statusText", (err as AxiosError).message));
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

import { winston, BigNumber, MAX_UINT_VAL } from "../utils";
import { l2TokensToL1TokenValidation } from "../common";
import axios, { AxiosError } from "axios";
import get from "lodash.get";

export interface DepositLimits {
  maxDeposit: BigNumber;
}

export class AcrossApiClient {
  private endpoint = "https://across.to/api/";

  private limits: { [token: string]: BigNumber } = {};

  constructor(readonly logger: winston.Logger, readonly tokensQuery: string[] = [], readonly timeout: number = 5000) {
    if (Object.keys(tokensQuery).length === 0) this.tokensQuery = Object.keys(l2TokensToL1TokenValidation);
  }

  async update(): Promise<void> {
    this.logger.debug({
      at: "AcrossAPIClient",
      message: "Updating AcrossAPI client",
      timeout: this.timeout,
      tokensQuery: this.tokensQuery,
      endpoint: this.endpoint,
    });

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
      this.limits[l1Token] = data[i]?.maxDeposit ? data[i].maxDeposit : BigNumber.from(MAX_UINT_VAL);
    }
    this.logger.debug({
      at: "AcrossAPIClient",
      message: "🏁 Fetched max deposit limits",
      limits: this.limits,
    });

    this.logger.debug({ at: "AcrossAPIClient", message: "AcrossAPI client updated!" });
  }

  getLimit(l1Token: string): BigNumber {
    return this.limits[l1Token] ? this.limits[l1Token] : BigNumber.from(MAX_UINT_VAL);
  }

  private async callLimits(
    l1Token: string,
    destinationChainId: number,
    timeout = this.timeout
  ): Promise<DepositLimits> {
    const path = "limits";
    const url = `${this.endpoint}${path}`;
    const params = { token: l1Token, destinationChainId };

    try {
      const result = await axios(url, { timeout, params });
      return result.data;
    } catch (err) {
      const msg = get(err, "response.data", get(err, "response.statusText", (err as AxiosError).message));
      this.logger.warn({
        at: "AcrossAPIClient",
        message: "Failed to get /limits",
        url,
        params,
        msg,
      });
    }
  }
}

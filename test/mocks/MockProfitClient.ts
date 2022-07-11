import { BigNumber } from "../utils";
import { ProfitClient } from "../../src/clients";

export class MockProfitClient extends ProfitClient {
  setTokenPrices(tokenPrices: { [l1Token: string]: BigNumber }) {
    this.tokenPrices = tokenPrices;
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async update() {}
}

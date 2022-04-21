import { BigNumber } from "../utils";
import { ProfitClient } from "../../src/clients";

export class MockProfitClient extends ProfitClient {
  setTokenPrices(tokenPrices: { [l1Token: string]: BigNumber }) {
    this.tokenPrices = tokenPrices;
  }

  async update() {}
}

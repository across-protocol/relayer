import { BigNumber } from "../utils";
import { ProfitClient } from "../../src/clients";

export class MockProfitClient extends ProfitClient {
  setTokenPrices(tokenPrices: { [l1Token: string]: BigNumber }): void {
    this.tokenPrices = tokenPrices;
  }

  setGasCosts(gasCosts: { [chainId: number]: BigNumber }): void {
    this.totalGasCosts = gasCosts;
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async update(): Promise<void> {}
}

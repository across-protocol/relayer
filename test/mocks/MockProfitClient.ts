import { BigNumber, toBN, toBNWei } from "../utils";
import { GAS_TOKEN_BY_CHAIN_ID, ProfitClient, WETH } from "../../src/clients";

export class MockProfitClient extends ProfitClient {
  setTokenPrices(tokenPrices: { [l1Token: string]: BigNumber }): void {
    this.tokenPrices = tokenPrices;
  }

  getPriceOfToken(l1Token: string): BigNumber {
    if (this.tokenPrices[l1Token] === undefined) return toBNWei(1);
    else return this.tokenPrices[l1Token];
  }

  setGasCosts(gasCosts: { [chainId: number]: BigNumber }): void {
    this.totalGasCosts = gasCosts;
  }

  setGasMultiplier(gasMultiplier: BigNumber): void {
    this.gasMultiplier = gasMultiplier;
  }

  // Some tests run against mocked chains, so hack in the necessary parts
  testInit(): void {
    GAS_TOKEN_BY_CHAIN_ID[666] = WETH;
    GAS_TOKEN_BY_CHAIN_ID[1337] = WETH;

    this.setGasCosts({
      666: toBN(100_000),
      1337: toBN(100_000),
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async update(): Promise<void> {}
}

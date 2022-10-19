import { BigNumber, toBN, toBNWei } from "../utils";
import { GAS_TOKEN_BY_CHAIN_ID, ProfitClient, WETH } from "../../src/clients";

export class MockProfitClient extends ProfitClient {
  setTokenPrices(tokenPrices: { [l1Token: string]: BigNumber }): void {
    this.tokenPrices = tokenPrices;
  }

  setGasCosts(gasCosts: { [chainId: number]: BigNumber }): void {
    this.totalGasCosts = gasCosts;
  }

  // Some tests run against mocked chains, so hack in the necessary parts
  testInit(): void {
    GAS_TOKEN_BY_CHAIN_ID[666] = WETH;
    GAS_TOKEN_BY_CHAIN_ID[1337] = WETH;

    this.setTokenPrices({
      "0x9c65f85425c619A6cB6D29fF8d57ef696323d188": toBNWei(1),
      "0x5FeaeBfB4439F3516c74939A9D04e95AFE82C4ae": toBNWei(1),
      "0xE6E340D132b5f46d1e472DebcD681B2aBc16e57E": toBNWei(1),
      "0x2B0d36FACD61B71CC05ab8F3D2355ec3631C0dd5": toBNWei(1),
      "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": toBNWei(1),
    });

    this.setGasCosts({
      666: toBN(100_000),
      1337: toBN(100_000),
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async update(): Promise<void> {}
}

import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import { GAS_TOKEN_BY_CHAIN_ID, HubPoolClient, ProfitClient, WETH } from "../../src/clients";
import { SpokePoolClientsByChain } from "../../src/interfaces";
import { BigNumber, winston } from "../utils";

export class MockProfitClient extends ProfitClient {
  constructor(
    logger: winston.Logger,
    hubPoolClient: HubPoolClient,
    spokePoolClients: SpokePoolClientsByChain,
    enabledChainIds: number[],
    defaultMinRelayerFeePct?: BigNumber,
    debugProfitability?: boolean,
    gasMultiplier?: BigNumber
  ) {
    super(
      logger,
      hubPoolClient,
      spokePoolClients,
      enabledChainIds,
      defaultMinRelayerFeePct,
      debugProfitability,
      gasMultiplier
    );

    // Some tests run against mocked chains, so hack in the necessary parts
    Object.values(spokePoolClients).map(({ chainId }) => {
      this.setGasCost(chainId, sdkUtils.bnOne);
      GAS_TOKEN_BY_CHAIN_ID[chainId] ??= WETH;
    });
    this.setTokenPrice(WETH, sdkUtils.bnOne);
  }

  setTokenPrice(l1Token: string, price: BigNumber | undefined): void {
    if (price) {
      this.tokenPrices[l1Token] = price;
    } else {
      delete this.tokenPrices[l1Token];
    }
  }

  setTokenPrices(tokenPrices: { [l1Token: string]: BigNumber }): void {
    this.tokenPrices = tokenPrices;
  }

  setGasCost(chainId: number, gas: BigNumber | undefined): void {
    if (gas) {
      this.totalGasCosts[chainId] = gas;
    } else {
      delete this.totalGasCosts[chainId];
    }
  }

  setGasCosts(gasCosts: { [chainId: number]: BigNumber }): void {
    this.totalGasCosts = gasCosts;
  }

  setGasMultiplier(gasMultiplier: BigNumber): void {
    this.gasMultiplier = gasMultiplier;
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async update(): Promise<void> {}
}

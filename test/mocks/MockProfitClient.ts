import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import { HubPoolClient, ProfitClient } from "../../src/clients";
import { SpokePoolClientsByChain } from "../../src/interfaces";
import { isDefined } from "../../src/utils";
import { BigNumber, winston } from "../utils";

export class MockProfitClient extends ProfitClient {
  constructor(
    logger: winston.Logger,
    hubPoolClient: HubPoolClient,
    spokePoolClients: SpokePoolClientsByChain,
    enabledChainIds: number[],
    relayerAddress: string,
    defaultMinRelayerFeePct?: BigNumber,
    debugProfitability?: boolean,
    gasMultiplier?: BigNumber
  ) {
    super(
      logger,
      hubPoolClient,
      spokePoolClients,
      enabledChainIds,
      relayerAddress,
      defaultMinRelayerFeePct,
      debugProfitability,
      gasMultiplier
    );

    // Some tests run against mocked chains, so hack in the necessary parts
    Object.values(spokePoolClients).map(({ chainId }) => {
      // Ensure a minimum price for the gas token.
      const gasToken = this.resolveGasToken(hubPoolClient.chainId);
      const gasTokenPrice = this.getPriceOfToken(gasToken.address);
      if (!isDefined(gasTokenPrice) || gasTokenPrice.eq(sdkUtils.bnZero)) {
        this.setTokenPrice(gasToken.address, sdkUtils.bnOne);
      }

      this.setGasCost(chainId, sdkUtils.bnOne); // Units of gas for a single fillRelay() execution.
    });
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

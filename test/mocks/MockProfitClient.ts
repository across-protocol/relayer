import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import { HubPoolClient, ProfitClient } from "../../src/clients";
import { SpokePoolClientsByChain } from "../../src/interfaces";
import { BigNumber, toBN, toBNWei, winston } from "../utils";

type TransactionCostEstimate = sdkUtils.TransactionCostEstimate;

const defaultFillCost = toBN(100_000); // gas
const defaultGasPrice = sdkUtils.bnOne; // wei per gas


export class MockProfitClient extends ProfitClient {
  constructor(
    logger: winston.Logger,
    hubPoolClient: HubPoolClient,
    spokePoolClients: SpokePoolClientsByChain,
    enabledChainIds: number[],
    relayerAddress: string,
    defaultMinRelayerFeePct?: BigNumber,
    debugProfitability?: boolean,
    gasMultiplier = toBNWei("1"),
    gasPadding = toBNWei("0")
  ) {
    super(
      logger,
      hubPoolClient,
      spokePoolClients,
      enabledChainIds,
      relayerAddress,
      defaultMinRelayerFeePct,
      debugProfitability,
      gasMultiplier,
      gasPadding
    );

    // Some tests run against mocked chains, so hack in the necessary parts
    const defaultGasCost = {
      nativeGasCost: defaultFillCost,
      tokenGasCost: defaultGasPrice.mul(defaultFillCost),
    };
    Object.values(spokePoolClients).map(({ chainId }) =>
      this.setGasCost(chainId, defaultGasCost)
    );
  }

  setTokenPrice(l1Token: string, price?: BigNumber): void {
    if (price) {
      this.tokenPrices[l1Token] = price;
    } else {
      delete this.tokenPrices[l1Token];
    }
  }

  setTokenPrices(tokenPrices: { [l1Token: string]: BigNumber }): void {
    this.tokenPrices = tokenPrices;
  }

  setGasCost(chainId: number, gas?: TransactionCostEstimate): void {
    if (gas) {
      this.totalGasCosts[chainId] = gas;
    } else {
      delete this.totalGasCosts[chainId];
    }
  }

  setGasCosts(gasCosts: { [chainId: number]: TransactionCostEstimate }): void {
    this.totalGasCosts = gasCosts;
  }

  setGasPadding(gasPadding: BigNumber): void {
    this.gasPadding = gasPadding;
  }

  setGasMultiplier(gasMultiplier: BigNumber): void {
    this.gasMultiplier = gasMultiplier;
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async update(): Promise<void> {}
}

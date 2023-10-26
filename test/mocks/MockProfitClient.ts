import { assert } from "chai";
import { Contract } from "ethers";
import { TOKEN_SYMBOLS_MAP } from "@across-protocol/constants-v2";
import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import { HubPoolClient, ProfitClient } from "../../src/clients";
import { SpokePoolClientsByChain } from "../../src/interfaces";
import { isDefined } from "../../src/utils";
import { BigNumber, winston } from "../utils";
import { MockHubPoolClient } from "./MockHubPoolClient";

export class MockProfitClient extends ProfitClient {
  constructor(
    logger: winston.Logger,
    hubPoolClient: HubPoolClient | MockHubPoolClient,
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

    // Initialise with known mainnet ERC20s
    Object.entries(TOKEN_SYMBOLS_MAP).forEach(([symbol, { decimals, addresses }]) => {
      const address = addresses[hubPoolClient.chainId];
      assert(isDefined(address), `Unsupported chain ID: ${hubPoolClient.chainId}`);

      this.mapToken(symbol, address);
      this.setTokenPrice(symbol, sdkUtils.bnOne);
      if (this.hubPoolClient instanceof MockHubPoolClient) {
        this.hubPoolClient.addL1Token({ symbol, decimals, address });
      }
    });

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

  async initToken(erc20: Contract): Promise<void> {
    const symbol = await erc20.symbol();
    this.mapToken(symbol, erc20.address);
    this.setTokenPrice(symbol, sdkUtils.bnOne);
  }

  mapToken(symbol: string, address: string): void {
    this.tokenSymbolMap[symbol] = address;
  }

  setTokenPrice(token: string, price: BigNumber | undefined): void {
    const address = this.resolveTokenAddress(token);
    if (price) {
      this.tokenPrices[address] = price;
    } else {
      delete this.tokenPrices[address];
    }
  }

  setTokenPrices(tokenPrices: { [token: string]: BigNumber }): void {
    this.tokenPrices = {};
    Object.entries(tokenPrices).forEach(([token, price]) => {
      const address = this.resolveTokenAddress(token);
      this.tokenPrices[address] = price;
    });
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

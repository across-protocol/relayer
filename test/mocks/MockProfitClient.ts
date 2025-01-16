import { utils as sdkUtils } from "@across-protocol/sdk";
import { ProfitClient } from "../../src/clients";
import { SpokePoolClientsByChain } from "../../src/interfaces";
import { bnOne, isDefined, TOKEN_SYMBOLS_MAP } from "../../src/utils";
import { BigNumber, toBN, toBNWei, winston } from "../utils";
import { MockHubPoolClient } from "./MockHubPoolClient";

type TransactionCostEstimate = sdkUtils.TransactionCostEstimate;

const defaultFillCost = toBN(100_000); // gas
const defaultGasPrice = bnOne; // wei per gas

export class MockProfitClient extends ProfitClient {
  constructor(
    logger: winston.Logger,
    hubPoolClient: HubPoolClient | MockHubPoolClient,
    spokePoolClients: SpokePoolClientsByChain,
    enabledChainIds: number[],
    relayerAddress: string,
    defaultMinRelayerFeePct?: BigNumber,
    debugProfitability?: boolean,
    gasMultiplier = toBNWei("1"),
    gasMessageMultiplier = toBNWei("1"),
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
      gasMessageMultiplier,
      gasPadding
    );

    // Initialise with known mainnet ERC20s
    Object.entries(TOKEN_SYMBOLS_MAP).forEach(([symbol, { decimals, addresses }]) => {
      const address = addresses[hubPoolClient.chainId];
      if (isDefined(address)) {
        this.mapToken(symbol, address);
        this.setTokenPrice(symbol, bnOne);
        if (this.hubPoolClient instanceof MockHubPoolClient) {
          this.hubPoolClient.addL1Token({ symbol, decimals, address });
        }
      } else {
        logger.debug({
          at: "MockProfitClient",
          message: `Skipping ${symbol}: not supported on ${hubPoolClient.chainId}`,
        });
      }
    });

    // Some tests run against mocked chains, so hack in the necessary parts
    const defaultGasCost = {
      nativeGasCost: defaultFillCost,
      tokenGasCost: defaultGasPrice.mul(defaultFillCost),
      gasPrice: defaultGasPrice,
    };
    Object.values(spokePoolClients).map(({ chainId }) => {
      this.setGasCost(chainId, defaultGasCost); // gas/fill

      const gasToken = this.resolveGasToken(chainId);
      this.setTokenPrice(gasToken.address, defaultGasPrice); // usd wei
    });
  }

  async initToken(erc20: Contract): Promise<void> {
    const symbol = await erc20.symbol();
    this.mapToken(symbol, erc20.address);
    this.setTokenPrice(symbol, bnOne);
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

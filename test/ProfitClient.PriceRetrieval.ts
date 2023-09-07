import { L1Token } from "../src/interfaces";
import {
  expect,
  ethers,
  createSpyLogger,
  hubPoolFixture,
  deployConfigStore,
  winston,
  BigNumber,
  toBN,
  toBNWei,
} from "./utils";

import { MockHubPoolClient } from "./mocks";
import { ConfigStoreClient, ProfitClient, MATIC, WETH } from "../src/clients"; // Tested

const mainnetTokens: Array<L1Token> = [
  // Checksummed addresses
  { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
  // Lower-case addresses
  { symbol: "WBTC", address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", decimals: 8 },
  { symbol: "BOBA", address: "0x42bbfa2e77757c645eeaad1655e0911a7553efbc", decimals: 18 },
  { symbol: "BAL", address: "0xba100000625a3754423978a60c9317c58a424e3d", decimals: 18 },
  // Upper-case addresses
  { symbol: "UMA", address: "0X04FA0D235C4ABF4BCF4787AF4CF447DE572EF828", decimals: 18 },
  { symbol: "BADGER", address: "0X3472A5A71965499ACD81997A54BBA8D852C6E53D", decimals: 18 },
  // Misc.
  { symbol: "WETH", address: WETH, decimals: 18 },
  { symbol: "MATIC", address: MATIC, decimals: 18 },
];

const tokenPrices: { [addr: string]: string } = Object.fromEntries(
  mainnetTokens.map((token) => {
    return [token.address, Math.random().toPrecision(10)];
  })
);

class ProfitClientWithMockPriceClient extends ProfitClient {
  protected override updateTokenPrices(): Promise<void> {
    const l1Tokens: { [k: string]: L1Token } = Object.fromEntries(
      this.hubPoolClient.getL1Tokens().map((token) => [token["address"], token])
    );

    Object.keys(l1Tokens).forEach((address) => {
      this.tokenPrices[address] = toBNWei(tokenPrices[address]);
    });

    return Promise.resolve();
  }
}

const verifyTokenPrices = (logger: winston.Logger, profitClient: ProfitClientWithMockPriceClient) => {
  const tokenPrices: { [k: string]: BigNumber } = profitClient.getAllPrices();

  // The client should have fetched prices for all requested tokens.
  expect(Object.keys(tokenPrices)).to.have.deep.members(mainnetTokens.map((token) => token["address"]));
  Object.values(tokenPrices).forEach((price: BigNumber) => expect(toBN(price).gt(toBN(0))).to.be.true);
  Object.keys(tokenPrices).forEach((token) => expect(toBN(profitClient.getPriceOfToken(token)).gt(toBN(0))).to.be.true);
};

// Define LOG_IN_TEST for logging to console.
const { spyLogger }: { spyLogger: winston.Logger } = createSpyLogger();
let hubPoolClient: MockHubPoolClient;
let profitClient: ProfitClientWithMockPriceClient; // tested

describe("ProfitClient: Price Retrieval", function () {
  beforeEach(async function () {
    const [owner] = await ethers.getSigners();

    const { hubPool, dai: l1Token } = await hubPoolFixture();
    const { configStore } = await deployConfigStore(owner, [l1Token]);

    const configStoreClient = new ConfigStoreClient(spyLogger, configStore);
    await configStoreClient.update();

    hubPoolClient = new MockHubPoolClient(spyLogger, hubPool, configStoreClient);
    await hubPoolClient.update();

    mainnetTokens.forEach((token: L1Token) => hubPoolClient.addL1Token(token));
    profitClient = new ProfitClientWithMockPriceClient(spyLogger, hubPoolClient, {}, [], toBN(0));
  });

  it("Correctly fetches token prices", async function () {
    await profitClient.update();
    verifyTokenPrices(spyLogger, profitClient);
  });
});

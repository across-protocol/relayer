import { L1Token } from "../src/interfaces";
import { expect, createSpyLogger, winston, BigNumber, toBN } from "./utils";

import { MockHubPoolClient } from "./mocks";
import { ProfitClient, MATIC } from "../src/clients"; // Tested

let hubPoolClient: MockHubPoolClient, spy: sinon.SinonSpy, spyLogger: winston.Logger;

const mainnetTokens: Array<L1Token> = [
  // Checksummed addresses
  { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
  { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  // Lower-case addresses
  { symbol: "WBTC", address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", decimals: 8 },
  { symbol: "BOBA", address: "0x42bbfa2e77757c645eeaad1655e0911a7553efbc", decimals: 18 },
  { symbol: "BAL", address: "0xba100000625a3754423978a60c9317c58a424e3d", decimals: 18 },
  // Upper-case addresses
  { symbol: "DAI", address: "0X6B175474E89094C44DA98B954EEDEAC495271D0F", decimals: 18 },
  { symbol: "UMA", address: "0X04FA0D235C4ABF4BCF4787AF4CF447DE572EF828", decimals: 18 },
  { symbol: "BADGER", address: "0X3472A5A71965499ACD81997A54BBA8D852C6E53D", decimals: 18 },
  // Misc.
  { symbol: "MATIC", address: MATIC, decimals: 18 },
];

class ProfitClientWithMockCoingecko extends ProfitClient {
  protected async coingeckoPrices(tokens: string[], platformId?: string) {
    return mainnetTokens.map((token) => {
      return { address: token.address, price: 1 };
    });
  }
}
let profitClient: ProfitClientWithMockCoingecko; // tested

describe("ProfitClient: Price Retrieval", async function () {
  beforeEach(async function () {
    ({ spy, spyLogger } = createSpyLogger());

    hubPoolClient = new MockHubPoolClient(null, null);
    profitClient = new ProfitClientWithMockCoingecko(spyLogger, hubPoolClient, {}, true, [], false, toBN(0));
  });

  it("Correctly fetches token prices", async function () {
    mainnetTokens.forEach((token: L1Token) => hubPoolClient.addL1Token(token));
    await profitClient.update();

    const tokenPrices: { [k: string]: BigNumber } = profitClient.getAllPrices();

    // The client should have fetched prices for all requested tokens.
    expect(Object.keys(tokenPrices)).to.have.deep.members(mainnetTokens.map((token) => token["address"]));
    Object.values(tokenPrices).forEach((price: BigNumber) => expect(toBN(price).gt(toBN(0))).to.be.true);
    Object.keys(tokenPrices).forEach(
      (token) => expect(toBN(profitClient.getPriceOfToken(token)).gt(toBN(0))).to.be.true
    );
  });
});

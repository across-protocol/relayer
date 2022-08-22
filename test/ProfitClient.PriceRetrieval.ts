import { L1Token } from "../src/interfaces";
import { expect, createSpyLogger, winston, BigNumber, toBN } from "./utils";

import { MockHubPoolClient } from "./mocks";
import { ProfitClient, MATIC, WETH } from "../src/clients"; // Tested

let hubPoolClient: MockHubPoolClient, spy: sinon.SinonSpy, spyLogger: winston.Logger;

const mainnetTokens: Array<L1Token> = [
  { symbol: "WETH", address: WETH, decimals: 18 },
  { symbol: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6 },
  { symbol: "WBTC", address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", decimals: 8 },
  { symbol: "BOBA", address: "0x42bbfa2e77757c645eeaad1655e0911a7553efbc", decimals: 18 },
  { symbol: "DAI", address: "0x6b175474e89094c44da98b954eedeac495271d0f", decimals: 18 },
  { symbol: "UMA", address: "0x04fa0d235c4abf4bcf4787af4cf447de572ef828", decimals: 18 },
  { symbol: "BADGER", address: "0x3472a5a71965499acd81997a54bba8d852c6e53d", decimals: 18 },
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
    mainnetTokens.forEach((token: L1Token) => hubPoolClient.addL1Token(token));
    profitClient = new ProfitClientWithMockCoingecko(spyLogger, hubPoolClient, {}, true, [], false, toBN(0));
  });

  it("Correctly fetches token prices", async function () {
    await profitClient.update();
    verifyTokenPrices();
  });

  it("Still fetches prices when profitability is disabled", async function () {
    // enableRelayProfitability is set to false.
    profitClient = new ProfitClientWithMockCoingecko(spyLogger, hubPoolClient, {}, false, []);

    // Verify that update() still fetches prices from Coingecko.
    await profitClient.update();
    verifyTokenPrices();
  });
});

const verifyTokenPrices = () => {
  const tokenPrices: { [k: string]: BigNumber } = profitClient.getAllPrices();

  // The client should have fetched prices for all requested tokens.
  expect(Object.keys(tokenPrices)).to.have.deep.members(mainnetTokens.map((token) => token["address"]));
  Object.values(tokenPrices).forEach((price: BigNumber) => expect(toBN(price).gt(toBN(0))).to.be.true);
  Object.keys(tokenPrices).forEach((token) => expect(toBN(profitClient.getPriceOfToken(token)).gt(toBN(0))).to.be.true);
};

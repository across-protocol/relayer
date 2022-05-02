import { expect, ethers, SignerWithAddress, createSpyLogger, winston, BigNumber, toBN } from "./utils";

import { MockHubPoolClient } from "./mocks/MockHubPoolClient";
import { ProfitClient } from "../src/clients"; // Tested

let hubPoolClient: MockHubPoolClient, owner: SignerWithAddress, spy: sinon.SinonSpy, spyLogger: winston.Logger;
let profitClient: ProfitClient; // tested

const mainnetWeth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const mainnetUsdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

describe("ProfitClient: Price Retrieval", async function () {
  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    ({ spy, spyLogger } = createSpyLogger());

    hubPoolClient = new MockHubPoolClient(null, null);;
    profitClient = new ProfitClient(spyLogger, hubPoolClient, toBN(0));
  });

  it("Correctly fetches token prices", async function () {
    // Set the MockHubPool to have WETH and USDC in it.
    hubPoolClient.addL1Token({ address: mainnetWeth, symbol: "WETH", decimals: 18 });
    hubPoolClient.addL1Token({ address: mainnetUsdc, symbol: "USDC", decimals: 6 });
    await profitClient.update();

    // The client should have fetched the prices for both tokens.
    expect(Object.keys(profitClient.getAllPrices())).to.deep.equal([mainnetWeth, mainnetUsdc]);
    Object.values(profitClient.getAllPrices()).forEach(
      (price: BigNumber) => expect(toBN(price).gt(toBN(0))).to.be.true
    );
    Object.keys(profitClient.getAllPrices()).forEach(
      (token) => expect(toBN(profitClient.getPriceOfToken(token)).gt(toBN(0))).to.be.true
    );
  });
});

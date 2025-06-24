import { ConfigStoreClient, ProfitClient } from "../src/clients"; // Tested
import { L1Token } from "../src/interfaces";
import { bnZero, TOKEN_SYMBOLS_MAP, toAddressType, toBytes32, toAddressType } from "../src/utils";
import { expect, ethers, createSpyLogger, hubPoolFixture, deployConfigStore, randomAddress, toBNWei } from "./utils";
import { MockHubPoolClient } from "./mocks";

const mainnetTokens = ["WETH", "WBTC", "DAI", "USDC", "USDT", "BAL", "MATIC"].map((symbol) => {
  const { decimals, addresses } = TOKEN_SYMBOLS_MAP[symbol];
  const address = addresses[1];
  return { symbol, decimals, address };
});

const tokenPrices: { [addr: string]: string } = Object.fromEntries(
  mainnetTokens.map(({ address }) => [address, Math.random().toPrecision(10)])
);

class ProfitClientWithMockPriceClient extends ProfitClient {
  protected override async updateTokenPrices(): Promise<void> {
    const l1Tokens: { [k: string]: L1Token } = Object.fromEntries(
      this.hubPoolClient.getL1Tokens().map((token) => [token.address, token])
    );

    Object.entries(l1Tokens).forEach(([address, { symbol }]) => {
      this.tokenSymbolMap[symbol] ??= address;
      this.tokenPrices[toBytes32(address)] = toBNWei(tokenPrices[address]);
    });
  }
}

describe("ProfitClient: Price Retrieval", async () => {
  // Define LOG_IN_TEST for logging to console.
  const { spyLogger } = createSpyLogger();
  let hubPoolClient: MockHubPoolClient;
  let profitClient: ProfitClientWithMockPriceClient; // tested

  beforeEach(async function () {
    const [owner] = await ethers.getSigners();
    const { hubPool, dai: l1Token } = await hubPoolFixture();
    const { configStore } = await deployConfigStore(owner, [l1Token]);

    const configStoreClient = new ConfigStoreClient(spyLogger, configStore);
    await configStoreClient.update();

    hubPoolClient = new MockHubPoolClient(spyLogger, hubPool, configStoreClient);
    await hubPoolClient.update();

    mainnetTokens.forEach((token) => hubPoolClient.addL1Token(token));
    const relayerAddress = toAddressType(randomAddress(), hubPoolClient.chainId);
    profitClient = new ProfitClientWithMockPriceClient(spyLogger, hubPoolClient, {}, [], relayerAddress, bnZero);
  });

  it("Correctly fetches token prices", async () => {
    await profitClient.update();
    const tokenPrices = profitClient.getAllPrices();

    // The client should have fetched prices for all requested tokens.
    mainnetTokens
      .map(({ address }) => address)
      .forEach((address) => expect(tokenPrices[toBytes32(address)]).to.not.be.undefined);
    Object.values(tokenPrices).forEach((price) => expect(price.gt(bnZero)).to.be.true);
    Object.keys(tokenPrices).forEach(
      (token) =>
        expect(profitClient.getPriceOfToken(toAddressType(token, hubPoolClient.chainId).toEvmAddress()).gt(bnZero)).to
          .be.true
    );
  });

  it("Correctly resolves addresses for gas token symbols", async () => {
    await profitClient.update();
    ["ETH", "MATIC"].forEach((gasToken) => expect(profitClient.resolveTokenAddress(gasToken)).to.not.be.undefined);
  });

  it("Remaps token symbols to equivalent token symbols", async () => {
    await profitClient.update();
    ["USDbC", "USDC.e"].forEach((unknownL1Token) =>
      expect(profitClient.resolveTokenAddress(unknownL1Token).toEvmAddress()).to.equal(
        TOKEN_SYMBOLS_MAP["USDC"].addresses[1]
      )
    );
  });
});

import { assertPromiseError, expect } from "./utils";
import { BinanceClient } from "../src/clients";

describe("BinanceClient", function () {
  const savedEnv = {
    BINANCE_API_KEY: process.env.BINANCE_API_KEY,
    BINANCE_HMAC_KEY: process.env.BINANCE_HMAC_KEY,
  };

  beforeEach(function () {
    delete process.env.BINANCE_API_KEY;
    delete process.env.BINANCE_HMAC_KEY;
  });

  after(function () {
    process.env.BINANCE_API_KEY = savedEnv.BINANCE_API_KEY;
    process.env.BINANCE_HMAC_KEY = savedEnv.BINANCE_HMAC_KEY;
  });

  it("create() throws when credentials are missing", async function () {
    await assertPromiseError(BinanceClient.create(), "Binance client cannot be constructed");
  });

  it("create() returns a BinanceClient when API key + HMAC key are configured", async function () {
    process.env.BINANCE_API_KEY = "test-api-key";
    process.env.BINANCE_HMAC_KEY = "test-hmac-key";
    const client = await BinanceClient.create();
    expect(client).to.be.instanceOf(BinanceClient);
  });
});

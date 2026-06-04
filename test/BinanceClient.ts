import winston from "winston";
import { assertPromiseError, expect } from "./utils";
import { BinanceClient } from "../src/clients";

describe("BinanceClient", function () {
  const savedEnv = {
    BINANCE_API_KEY: process.env.BINANCE_API_KEY,
    BINANCE_HMAC_KEY: process.env.BINANCE_HMAC_KEY,
  };
  const deps = { logger: winston.createLogger({ silent: true }) };

  beforeEach(function () {
    delete process.env.BINANCE_API_KEY;
    delete process.env.BINANCE_HMAC_KEY;
  });

  after(function () {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("create() throws when credentials are missing", async function () {
    await assertPromiseError(BinanceClient.create(deps), "Binance client cannot be constructed");
  });

  it("create() returns a BinanceClient when API key + HMAC key are configured", async function () {
    process.env.BINANCE_API_KEY = "test-api-key";
    process.env.BINANCE_HMAC_KEY = "test-hmac-key";
    const client = await BinanceClient.create(deps);
    expect(client).to.be.instanceOf(BinanceClient);
  });
});

import sinon from "sinon";
import winston from "winston";
import { assertPromiseError, createSpyLogger, expect, toBNWei } from "./utils";
import { BinanceClient } from "../src/clients";
import { CHAIN_IDs, EvmAddress, TOKEN_SYMBOLS_MAP } from "../src/utils";

describe("BinanceClient", function () {
  const savedEnv = {
    BINANCE_API_KEY: process.env.BINANCE_API_KEY,
    BINANCE_HMAC_KEY: process.env.BINANCE_HMAC_KEY,
  };
  const deps = { logger: winston.createLogger({ silent: true }) };

  const { MAINNET, BSC } = CHAIN_IDs;
  const usdt = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDT.addresses[MAINNET]);

  // Shape of one accountCoins network entry; only the fields the client reads are populated.
  const network = (name: string, depositEnable?: boolean, withdrawEnable?: boolean) => ({
    network: name,
    coin: "USDT",
    withdrawMin: "1",
    withdrawMax: "1000000",
    withdrawFee: "1",
    contractAddress: "0x",
    depositEnable,
    withdrawEnable,
  });

  // Stand in for the binance-api-node client. accountCoins backs availability, privateRequest the quota.
  const fakeApi = (networkList: ReturnType<typeof network>[], accountCoinsThrows = false) =>
    ({
      accountCoins: async () => {
        if (accountCoinsThrows) {
          throw new Error("binance is down");
        }
        return { USDT: { coin: "USDT", free: "0", networkList } };
      },
      privateRequest: async () => ({ wdQuota: 1_000_000, usedWdQuota: 0 }),
    }) as unknown as ReturnType<BinanceClient["rawApi"]>;

  // BinanceClient.create() reads credentials from the environment, so seed them before constructing and
  // leave them set: hasBinanceRoute() (consulted by canWithdraw) also requires them.
  const makeClient = async (
    networkList: ReturnType<typeof network>[],
    opts: { accountCoinsThrows?: boolean; logger?: winston.Logger } = {}
  ): Promise<BinanceClient> => {
    process.env.BINANCE_API_KEY = "test-api-key";
    process.env.BINANCE_HMAC_KEY = "test-hmac-key";
    const client = await BinanceClient.create({ logger: opts.logger ?? deps.logger });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).api = fakeApi(networkList, opts.accountCoinsThrows);
    return client;
  };

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

  describe("route availability", function () {
    const routes = [{ chainId: BSC, l1Token: usdt }];

    it("treats a route as drainable when both legs are enabled", async function () {
      const client = await makeClient([network("ETH", true, true), network("BSC", true, true)]);
      await client.refresh(routes);
      expect(client.canDrainToHubChain(BSC, usdt)).to.be.true;
    });

    it("closes the route when Binance suspends the deposit leg on the source chain", async function () {
      const client = await makeClient([network("ETH", true, true), network("BSC", false, true)]);
      await client.refresh(routes);
      expect(client.isDepositEnabled(BSC, usdt)).to.be.false;
      expect(client.canDrainToHubChain(BSC, usdt)).to.be.false;
    });

    it("closes the route when Binance suspends the withdrawal leg on the hub chain", async function () {
      // The source leg is open, but funds deposited into Binance could not be withdrawn back to mainnet.
      const client = await makeClient([network("ETH", true, false), network("BSC", true, true)]);
      await client.refresh(routes);
      expect(client.isDepositEnabled(BSC, usdt)).to.be.true;
      expect(client.canDrainToHubChain(BSC, usdt)).to.be.false;
    });

    it("fails open when Binance omits the flags", async function () {
      const client = await makeClient([network("ETH"), network("BSC")]);
      await client.refresh(routes);
      expect(client.canDrainToHubChain(BSC, usdt)).to.be.true;
    });

    it("fails open when the availability snapshot is unavailable", async function () {
      // A Binance outage must not strand every route at once; this is the pre-existing behaviour.
      const client = await makeClient([], { accountCoinsThrows: true });
      await client.refresh(routes);
      expect(client.canDrainToHubChain(BSC, usdt)).to.be.true;
    });

    it("fails open before the first refresh", async function () {
      const client = await makeClient([network("ETH", false, false), network("BSC", false, false)]);
      expect(client.canDrainToHubChain(BSC, usdt)).to.be.true;
    });

    it("canWithdraw() rejects a suspended route even with quota available", async function () {
      // Draining BSC means depositing into Binance from BSC and withdrawing to mainnet, so it is the BSC
      // *deposit* leg that matters here — a suspended BSC withdrawal leg only blocks the hub -> BSC
      // direction and must not be conflated with it.
      const client = await makeClient([network("ETH", true, true), network("BSC", false, true)]);
      await client.refresh(routes);
      expect(client.canWithdraw(toBNWei(1), BSC, usdt)).to.be.false;

      const openClient = await makeClient([network("ETH", true, true), network("BSC", true, false)]);
      await openClient.refresh(routes);
      expect(openClient.canWithdraw(toBNWei(1), BSC, usdt)).to.be.true;
    });
  });

  describe("route availability logging", function () {
    const routes = [{ chainId: BSC, l1Token: usdt }];
    let spy: sinon.SinonSpy, spyLogger: winston.Logger;

    beforeEach(function () {
      ({ spy, spyLogger } = createSpyLogger());
    });

    const loggedAt = (level: string, needle: string) =>
      spy.getCalls().some((call) => call.lastArg?.level === level && (call.lastArg?.message ?? "").includes(needle));

    it("warns when a configured route is suspended", async function () {
      const client = await makeClient([network("ETH", true, true), network("BSC", true, false)], {
        logger: spyLogger,
      });
      await client.refresh(routes);
      expect(loggedAt("warn", "Binance has suspended deposits or withdrawals")).to.be.true;
    });

    it("does not warn while all configured routes are open", async function () {
      const client = await makeClient([network("ETH", true, true), network("BSC", true, true)], {
        logger: spyLogger,
      });
      await client.refresh(routes);
      expect(loggedAt("warn", "Binance has suspended deposits or withdrawals")).to.be.false;
      expect(loggedAt("debug", "Binance route availability")).to.be.true;
    });

    it("reports recovery once a suspended route reopens", async function () {
      const client = await makeClient([network("ETH", true, true), network("BSC", true, false)], {
        logger: spyLogger,
      });
      await client.refresh(routes);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).api = fakeApi([network("ETH", true, true), network("BSC", true, true)]);
      await client.refresh(routes);
      expect(loggedAt("info", "Binance has resumed deposits and withdrawals")).to.be.true;
    });

    it("warns when the availability snapshot cannot be fetched", async function () {
      const client = await makeClient([], { accountCoinsThrows: true, logger: spyLogger });
      await client.refresh(routes);
      expect(loggedAt("warn", "Failed to refresh Binance route availability")).to.be.true;
    });
  });
});

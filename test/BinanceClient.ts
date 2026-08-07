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
  const routes = [{ chainId: BSC, l1Token: usdt }];

  // Each network's flags are given as "<deposit><withdraw>": + open, - suspended, ? omitted by Binance.
  const flag = (c: string) => (c === "?" ? undefined : c === "+");

  // Stand in for binance-api-node: accountCoins backs availability, privateRequest the withdrawal quota.
  const fakeApi = (eth: string, bsc: string, throws = false) =>
    ({
      accountCoins: async () => {
        if (throws) {
          throw new Error("binance is down");
        }
        const net = (name: string, flags: string) => ({
          network: name,
          coin: "USDT",
          depositEnable: flag(flags[0]),
          withdrawEnable: flag(flags[1]),
        });
        return { USDT: { coin: "USDT", free: "0", networkList: [net("ETH", eth), net("BSC", bsc)] } };
      },
      privateRequest: async () => ({ wdQuota: 1_000_000, usedWdQuota: 0 }),
    }) as unknown as ReturnType<BinanceClient["rawApi"]>;

  // create() reads credentials from the environment; leave them set, since hasBinanceRoute() needs them too.
  const makeClient = async (eth: string, bsc: string, throws = false): Promise<BinanceClient> => {
    process.env.BINANCE_API_KEY = "test-api-key";
    process.env.BINANCE_HMAC_KEY = "test-hmac-key";
    const client = await BinanceClient.create({ logger: spyLogger });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).api = fakeApi(eth, bsc, throws);
    return client;
  };

  let spy: sinon.SinonSpy, spyLogger: winston.Logger;

  beforeEach(function () {
    delete process.env.BINANCE_API_KEY;
    delete process.env.BINANCE_HMAC_KEY;
    ({ spy, spyLogger } = createSpyLogger());
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
    // Draining BSC needs the BSC deposit leg and the mainnet withdrawal leg. The BSC withdrawal leg governs
    // only the hub -> BSC direction, so suspending it must not close the route.
    const cases: [string, string, string, boolean][] = [
      ["both legs open", "++", "++", true],
      ["source deposit leg suspended", "++", "-+", false],
      ["hub withdrawal leg suspended", "+-", "++", false],
      ["destination withdrawal leg suspended", "++", "+-", true],
      ["flags omitted", "??", "??", true],
    ];
    cases.forEach(([name, eth, bsc, expected]) => {
      it(`${name} -> drainable: ${expected}`, async function () {
        const client = await makeClient(eth, bsc);
        await client.refresh(routes);
        expect(client.canDrainToHubChain(BSC, usdt)).to.equal(expected);
        expect(client.canWithdraw(toBNWei(1), BSC, usdt)).to.equal(expected);
      });
    });

    it("fails open when the snapshot is unavailable", async function () {
      const client = await makeClient("--", "--", true);
      await client.refresh(routes);
      expect(client.canDrainToHubChain(BSC, usdt)).to.be.true;
    });

    it("fails open before the first refresh", async function () {
      const client = await makeClient("--", "--");
      expect(client.canDrainToHubChain(BSC, usdt)).to.be.true;
    });

    it("warns while a configured route is suspended", async function () {
      const warned = () =>
        spy.getCalls().some((call) => call.lastArg?.level === "warn" && call.lastArg?.message?.includes("suspended"));

      const open = await makeClient("++", "++");
      await open.refresh(routes);
      expect(warned()).to.be.false;

      const shut = await makeClient("++", "-+");
      await shut.refresh(routes);
      expect(warned()).to.be.true;
    });
  });
});

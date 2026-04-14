import { CHAIN_IDs } from "@across-protocol/constants";
import { BinanceStablecoinSwapAdapter } from "../src/rebalancer/adapters/binance";
import { ethers, expect, sinon, toBNWei } from "./utils";

describe("Binance adapter quotes", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("reuses a cached order book snapshot within the TTL", async function () {
    const adapter = await makeAdapter();
    const book = makeOrderBook({ asks: [{ price: "1.0001", quantity: "1000" }], bids: [] });
    const bookStub = sinon.stub().resolves(book);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).binanceApiClient = { book: bookStub };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = await (adapter as any)._getOrderBook("USDCUSDT");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = await (adapter as any)._getOrderBook("USDCUSDT");

    expect(first).to.equal(book);
    expect(second).to.equal(book);
    expect(bookStub.callCount).to.equal(1);
  });

  it("deduplicates concurrent order book fetches for the same symbol", async function () {
    const adapter = await makeAdapter();
    const book = makeOrderBook({ asks: [{ price: "1.0001", quantity: "1000" }], bids: [] });
    const bookStub = sinon.stub().callsFake(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return book;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).binanceApiClient = { book: bookStub };
    const quoteAdapter = adapter as unknown as {
      _getOrderBook(symbol: string): Promise<ReturnType<typeof makeOrderBook>>;
    };

    const [first, second] = await Promise.all([
      quoteAdapter._getOrderBook("USDCUSDT"),
      quoteAdapter._getOrderBook("USDCUSDT"),
    ]);

    expect(first).to.equal(book);
    expect(second).to.equal(book);
    expect(bookStub.callCount).to.equal(1);
  });

  it("retries transient order book fetch failures", async function () {
    const adapter = await makeAdapter();
    const book = makeOrderBook({ asks: [{ price: "1.0001", quantity: "1000" }], bids: [] });
    const bookStub = sinon.stub();
    bookStub.onCall(0).rejects(new Error("temporary outage"));
    bookStub.onCall(1).resolves(book);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).binanceApiClient = { book: bookStub };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fetched = await (adapter as any)._fetchOrderBook("USDCUSDT", 0, 1);

    expect(fetched).to.equal(book);
    expect(bookStub.callCount).to.equal(2);
  });

  it("throws a visible-depth error when the order book cannot satisfy the order size", async function () {
    const adapter = await makeAdapter();
    const exchangeInfo = {
      symbols: [
        {
          symbol: "USDCUSDT",
          baseAsset: "USDC",
          quoteAsset: "USDT",
          filters: [
            {
              filterType: "PRICE_FILTER",
              tickSize: "0.0001",
            },
            {
              filterType: "LOT_SIZE",
              stepSize: "0.01",
              minQty: "0.01",
            },
          ],
        },
      ],
    };
    const bookStub = sinon.stub().resolves(
      makeOrderBook({
        asks: [{ price: "1.0010", quantity: "10" }],
        bids: [],
      })
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).exchangeInfoPromise = Promise.resolve(exchangeInfo);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).binanceApiClient = { book: bookStub };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (adapter as any)._getLatestPrice("USDT", "USDC", CHAIN_IDs.MAINNET, toBNWei("1000", 6));
      expect.fail("expected _getLatestPrice to throw when the order book is too shallow");
    } catch (error) {
      expect(String(error)).to.contain("exceeds visible Binance order book depth");
    }
  });
});

async function makeAdapter(): Promise<BinanceStablecoinSwapAdapter> {
  const [signer] = await ethers.getSigners();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new BinanceStablecoinSwapAdapter(TEST_LOGGER, {} as any, signer, {} as any, {} as any);
}

function makeOrderBook({
  asks,
  bids,
}: {
  asks: Array<{ price: string; quantity: string }>;
  bids: Array<{ price: string; quantity: string }>;
}) {
  return { asks, bids };
}

const TEST_LOGGER = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

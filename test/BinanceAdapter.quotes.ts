import { CHAIN_IDs } from "@across-protocol/constants";
import { BinanceStablecoinSwapAdapter } from "../src/rebalancer/adapters/binance";
import { ethers, expect, sinon, toBNWei } from "./utils";

type OrderBook = ReturnType<typeof makeOrderBook>;
type QuoteTestAdapter = {
  binanceApiClient: {
    book?: sinon.SinonStub;
    exchangeInfo?: sinon.SinonStub;
  };
  exchangeInfoPromise?: Promise<{
    symbols: Array<{
      symbol: string;
      baseAsset: string;
      quoteAsset: string;
      filters: Array<{ filterType: string; tickSize?: string; stepSize?: string; minQty?: string }>;
    }>;
  }>;
  _getOrderBook(symbol: string): Promise<OrderBook>;
  _fetchOrderBook(symbol: string, fromId: number, limit: number): Promise<OrderBook>;
  _getLatestPrice(
    sourceToken: string,
    destinationToken: string,
    sourceChain: number,
    sourceAmount: ReturnType<typeof toBNWei>
  ): Promise<unknown>;
};

describe("Binance adapter quotes", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("reuses a cached order book snapshot within the TTL", async function () {
    const adapter = asQuoteAdapter(await makeAdapter());
    const book = makeOrderBook({ asks: [{ price: "1.0001", quantity: "1000" }], bids: [] });
    const bookStub = sinon.stub().resolves(book);
    adapter.binanceApiClient = { book: bookStub };

    const first = await adapter._getOrderBook("USDCUSDT");
    const second = await adapter._getOrderBook("USDCUSDT");

    expect(first).to.equal(book);
    expect(second).to.equal(book);
    expect(bookStub.callCount).to.equal(1);
  });

  it("deduplicates concurrent order book fetches for the same symbol", async function () {
    const adapter = asQuoteAdapter(await makeAdapter());
    const book = makeOrderBook({ asks: [{ price: "1.0001", quantity: "1000" }], bids: [] });
    const bookStub = sinon.stub().callsFake(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return book;
    });
    adapter.binanceApiClient = { book: bookStub };

    const [first, second] = await Promise.all([adapter._getOrderBook("USDCUSDT"), adapter._getOrderBook("USDCUSDT")]);

    expect(first).to.equal(book);
    expect(second).to.equal(book);
    expect(bookStub.callCount).to.equal(1);
  });

  it("retries transient order book fetch failures", async function () {
    const adapter = asQuoteAdapter(await makeAdapter());
    const book = makeOrderBook({ asks: [{ price: "1.0001", quantity: "1000" }], bids: [] });
    const bookStub = sinon.stub();
    bookStub.onCall(0).rejects(new Error("temporary outage"));
    bookStub.onCall(1).resolves(book);
    adapter.binanceApiClient = { book: bookStub };

    const fetched = await adapter._fetchOrderBook("USDCUSDT", 0, 1);

    expect(fetched).to.equal(book);
    expect(bookStub.callCount).to.equal(2);
  });

  it("throws a visible-depth error when the order book cannot satisfy the order size", async function () {
    const adapter = asQuoteAdapter(await makeAdapter());
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
    adapter.exchangeInfoPromise = Promise.resolve(exchangeInfo);
    adapter.binanceApiClient = { book: bookStub };

    try {
      await adapter._getLatestPrice("USDT", "USDC", CHAIN_IDs.MAINNET, toBNWei("1000", 6));
      expect.fail("expected _getLatestPrice to throw when the order book is too shallow");
    } catch (error) {
      expect(String(error)).to.contain("exceeds visible Binance order book depth");
    }
  });
});

async function makeAdapter(): Promise<BinanceStablecoinSwapAdapter> {
  const [signer] = await ethers.getSigners();
  return new BinanceStablecoinSwapAdapter(TEST_LOGGER as never, {} as never, signer, {} as never, {} as never);
}

function asQuoteAdapter(adapter: BinanceStablecoinSwapAdapter): QuoteTestAdapter {
  return adapter as unknown as QuoteTestAdapter;
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
};

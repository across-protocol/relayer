import { expect, sinon } from "./utils";
import {
  getEvmBinanceRebalanceLookupAccounts,
  getPendingBinanceRebalanceSweepReservationsForAccount,
  getPendingBinanceRebalanceSweepReservationsForOrder,
  getSweepableOrphanBinanceBalance,
  sumPendingBinanceRebalanceSweepReservations,
} from "../src/finalizer/utils/binance";
import { CHAIN_IDs, EvmAddress, toBNWei } from "../src/utils";
import { STATUS } from "../src/rebalancer/utils/utils";

describe("Binance finalizer helpers", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("sums Binance sweep reservations by symbol", function () {
    const reservations = sumPendingBinanceRebalanceSweepReservations([
      { USDC: 100, USDT: 50 },
      { USDC: 25, ETH: 1 },
    ]);

    expect(reservations).to.deep.equal({ USDC: 125, USDT: 50, ETH: 1 });
  });

  it("subtracts credited, swap, and reserved rebalance amounts from orphan sweep candidates", function () {
    const sweepableBalance = getSweepableOrphanBinanceBalance(250_000, 10_000, 20_000, 30_000);

    expect(sweepableBalance).to.equal(190_000);
  });

  it("skips non-EVM addresses when collecting pending rebalance accounts", function () {
    const evmAddress = "0x0000000000000000000000000000000000000001";
    const svmAddress = "11111111111111111111111111111111";

    const accounts = getEvmBinanceRebalanceLookupAccounts([evmAddress, svmAddress]);

    expect(accounts.map((account) => account.toNative())).to.deep.equal([EvmAddress.from(evmAddress).toNative()]);
  });

  it("includes the signer account when collecting pending rebalance accounts", function () {
    const recipientAddress = "0x0000000000000000000000000000000000000001";
    const signerAddress = "0x0000000000000000000000000000000000000002";

    const accounts = getEvmBinanceRebalanceLookupAccounts([recipientAddress], signerAddress);

    expect(accounts.map((account) => account.toNative())).to.deep.equal([
      EvmAddress.from(recipientAddress).toNative(),
      EvmAddress.from(signerAddress).toNative(),
    ]);
  });

  it("treats pending rebalance Redis lookup failures as an empty sweep guard", async function () {
    const logger = { warn: sinon.stub() };
    const account = EvmAddress.from("0x0000000000000000000000000000000000000001");
    const getRedisCache = sinon.stub().rejects(new Error("temporary redis outage"));

    const reservations = await getPendingBinanceRebalanceSweepReservationsForAccount(
      logger as never,
      account,
      {} as never,
      getRedisCache
    );

    expect(reservations).to.deep.equal({});
    expect(logger.warn.calledOnce).to.equal(true);
    expect(logger.warn.firstCall.args[0]).to.include({
      at: "BinanceFinalizer",
      account: account.toNative(),
      error: "temporary redis outage",
    });
  });

  it("does not reserve sweep amounts when pending order details have expired", async function () {
    const logger = { warn: sinon.stub() };
    const account = EvmAddress.from("0x0000000000000000000000000000000000000001");
    const redisCache = {
      sMembers: sinon.stub(),
      get: sinon.stub().resolves(undefined),
      sRem: sinon.stub(),
    };
    redisCache.sMembers.onFirstCall().resolves(["missing-cloid"]);
    redisCache.sMembers.resolves([]);

    const reservations = await getPendingBinanceRebalanceSweepReservationsForAccount(
      logger as never,
      account,
      {} as never,
      async () => redisCache as never
    );

    expect(reservations).to.deep.equal({});
    expect(redisCache.sRem.notCalled).to.equal(true);
    expect(logger.warn.calledOnce).to.equal(true);
    expect(logger.warn.firstCall.args[0]).to.include({
      at: "BinanceFinalizer",
      account: account.toNative(),
      cloid: "missing-cloid",
    });
  });

  it("reserves source token amount for pending Binance deposits", async function () {
    const reservations = await getPendingBinanceRebalanceSweepReservationsForOrder(
      { warn: sinon.stub() } as never,
      {} as never,
      "cloid",
      STATUS.PENDING_DEPOSIT,
      {
        sourceChain: CHAIN_IDs.MAINNET,
        sourceToken: "USDT",
        destinationChain: CHAIN_IDs.MAINNET,
        destinationToken: "USDC",
        amountToTransfer: toBNWei("100", 6),
      }
    );

    expect(reservations).to.deep.equal({ USDT: 100 });
  });

  it("reserves filled destination token amount for pending Binance swaps", async function () {
    const binanceApi = {
      exchangeInfo: sinon.stub().resolves({
        symbols: [
          {
            symbol: "USDCUSDT",
            baseAsset: "USDC",
            quoteAsset: "USDT",
            filters: [
              { filterType: "PRICE_FILTER", tickSize: "0.0001" },
              { filterType: "LOT_SIZE", stepSize: "1.00000000", minQty: "1.00000000" },
            ],
          },
        ],
      }),
      allOrders: sinon.stub().resolves([
        {
          clientOrderId: "cloid",
          status: "FILLED",
          orderId: 123,
          executedQty: "100",
          cummulativeQuoteQty: "100.1",
        },
      ]),
      myTrades: sinon.stub().resolves([{ commission: "1", commissionAsset: "USDC" }]),
    };

    const reservations = await getPendingBinanceRebalanceSweepReservationsForOrder(
      { warn: sinon.stub() } as never,
      binanceApi as never,
      "cloid",
      STATUS.PENDING_SWAP,
      {
        sourceChain: CHAIN_IDs.MAINNET,
        sourceToken: "USDT",
        destinationChain: CHAIN_IDs.MAINNET,
        destinationToken: "USDC",
        amountToTransfer: toBNWei("100", 6),
      }
    );

    expect(reservations).to.deep.equal({ USDC: 99 });
  });

  it("reserves estimated destination token amount when Binance fill lookup fails after a swap", async function () {
    const logger = { warn: sinon.stub() };
    const binanceApi = {
      exchangeInfo: sinon.stub().resolves({
        symbols: [
          {
            symbol: "ETHUSDC",
            baseAsset: "ETH",
            quoteAsset: "USDC",
            filters: [
              { filterType: "PRICE_FILTER", tickSize: "0.01" },
              { filterType: "LOT_SIZE", stepSize: "0.00010000", minQty: "0.00010000" },
            ],
          },
        ],
      }),
      allOrders: sinon.stub().rejects(new Error("rate limited")),
      myTrades: sinon.stub(),
      book: sinon.stub().resolves({
        asks: [],
        bids: [{ price: "2500", quantity: "10" }],
      }),
    };

    const reservations = await getPendingBinanceRebalanceSweepReservationsForOrder(
      logger as never,
      binanceApi as never,
      "cloid",
      STATUS.PENDING_WITHDRAWAL,
      {
        sourceChain: CHAIN_IDs.MAINNET,
        sourceToken: "WETH",
        destinationChain: CHAIN_IDs.MAINNET,
        destinationToken: "USDC",
        amountToTransfer: toBNWei("1", 18),
      }
    );

    expect(reservations).to.deep.equal({ USDC: 2500 });
    expect(logger.warn.calledOnce).to.equal(true);
    expect(logger.warn.firstCall.args[0]).to.include({
      at: "BinanceFinalizer",
      cloid: "cloid",
      error: "rate limited",
    });
  });
});

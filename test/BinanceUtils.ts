import { expect } from "./utils";
import {
  BINANCE_ORDER_RECV_WINDOW_MS,
  BINANCE_READ_RECV_WINDOW_MS,
  BINANCE_WITHDRAW_RECV_WINDOW_MS,
  BinanceDeposit,
  BinanceWithdrawal,
  getBinanceAllOrders,
  getBinanceDepositAddress,
  getBinanceTradeFees,
  getBinanceWithdrawalLimits,
  getOutstandingBinanceDeposits,
  submitBinanceOrder,
  submitBinanceWithdrawal,
  isCompletedBinanceWithdrawal,
} from "../src/utils";

function makeDeposit(network: string, amount: number, insertTime: number): BinanceDeposit {
  return { network, amount, coin: "USDT", txId: `0x${insertTime}`, insertTime };
}

function makeWithdrawal(amount: number, timestamp: number, transactionFee = 0): BinanceWithdrawal {
  return {
    network: "ETH",
    amount,
    coin: "USDT",
    txId: `0x${timestamp}`,
    recipient: "0xRelayer",
    id: `w${timestamp}`,
    transactionFee,
    applyTime: new Date(timestamp).toISOString(),
  };
}

describe("BinanceUtils: getOutstandingBinanceDeposits", function () {
  it("Multiple deposits, no withdrawals: all deposits are outstanding", function () {
    const deposits = [makeDeposit("BSC", 50_000, 1), makeDeposit("OPTIMISM", 40_000, 2), makeDeposit("BSC", 10_000, 3)];

    const outstanding = getOutstandingBinanceDeposits(deposits, [], "BSC");
    expect(outstanding.length).to.equal(2);
    expect(outstanding[0].amount).to.equal(10_000); // newest first (t=3)
    expect(outstanding[1].amount).to.equal(50_000); // oldest (t=1)

    const outstandingOP = getOutstandingBinanceDeposits(deposits, [], "OPTIMISM");
    expect(outstandingOP.length).to.equal(1);
    expect(outstandingOP[0].amount).to.equal(40_000);
  });

  it("Total deposits <= total withdrawals: no deposits are outstanding", function () {
    const deposits = [makeDeposit("BSC", 50_000, 1), makeDeposit("OPTIMISM", 40_000, 2)];

    // Exact match.
    expect(getOutstandingBinanceDeposits(deposits, [makeWithdrawal(90_000, 3)], "BSC")).to.deep.equal([]);

    // Withdrawals exceed deposits (dust/fees included).
    expect(getOutstandingBinanceDeposits(deposits, [makeWithdrawal(85_000, 3, 10_000)], "BSC")).to.deep.equal([]);
  });

  it("Newest deposits are outstanding first; oldest outstanding deposit gets partial amount", function () {
    // Four deposits totalling 100k. Withdrawals cover 65k. Outstanding = 35k.
    const deposits = [
      makeDeposit("BSC", 10_000, 1), // oldest
      makeDeposit("BSC", 30_000, 2),
      makeDeposit("BSC", 40_000, 3),
      makeDeposit("BSC", 20_000, 4), // newest
    ];
    const withdrawals = [makeWithdrawal(65_000, 5)];

    // Outstanding = 100k - 65k = 35k.
    // Newest-first: 20k (t=4) fully outstanding (remaining=15k), 40k (t=3) partially outstanding (amount=15k).
    const outstanding = getOutstandingBinanceDeposits(deposits, withdrawals, "BSC");
    expect(outstanding.length).to.equal(2);
    expect(outstanding[0].amount).to.equal(20_000);
    expect(outstanding[0].insertTime).to.equal(4);
    expect(outstanding[1].amount).to.equal(15_000); // partial: 35k - 20k = 15k remaining
    expect(outstanding[1].insertTime).to.equal(3);
  });

  it("Only outstanding deposits on the requested network are returned", function () {
    // 50k BSC + 40k OP = 90k total. Withdrawal covers 40k. Outstanding = 50k.
    // Newest deposit is BSC (t=3), then OP (t=2), then BSC (t=1).
    const deposits = [makeDeposit("BSC", 20_000, 1), makeDeposit("OPTIMISM", 40_000, 2), makeDeposit("BSC", 30_000, 3)];
    const withdrawals = [makeWithdrawal(40_000, 4)];

    // Outstanding = 90k - 40k = 50k.
    // Newest-first: BSC 30k (t=3, fully outstanding, remaining=20k), OP 40k (t=2, partially 20k).
    const outstandingBSC = getOutstandingBinanceDeposits(deposits, withdrawals, "BSC");
    expect(outstandingBSC.length).to.equal(1);
    expect(outstandingBSC[0].amount).to.equal(30_000);

    const outstandingOP = getOutstandingBinanceDeposits(deposits, withdrawals, "OPTIMISM");
    expect(outstandingOP.length).to.equal(1);
    expect(outstandingOP[0].amount).to.equal(20_000); // partial
  });

  it("Partial outstanding when withdrawal covers most of a deposit", function () {
    const deposits = [makeDeposit("BSC", 100, 1)];
    const withdrawals = [makeWithdrawal(95, 2)];

    const outstanding = getOutstandingBinanceDeposits(deposits, withdrawals, "BSC");
    expect(outstanding.length).to.equal(1);
    expect(outstanding[0].amount).to.equal(5);
  });

  it("Does not mutate input arrays or deposit objects", function () {
    const deposits = [makeDeposit("BSC", 100, 1)];
    const withdrawals = [makeWithdrawal(60, 2)];
    const originalAmount = deposits[0].amount;

    getOutstandingBinanceDeposits(deposits, withdrawals, "BSC");

    expect(deposits[0].amount).to.equal(originalAmount);
    expect(deposits.length).to.equal(1);
  });
});

describe("BinanceUtils recvWindow helpers", function () {
  it("applies the read recvWindow to signed read helpers", async function () {
    const calls: Record<string, unknown> = {};
    const binanceApi = {
      privateRequest: async (_method: string, _url: string, payload: object) => {
        calls.privateRequest = payload;
        return { wdQuota: 10, usedWdQuota: 1 };
      },
      tradeFee: async (payload: object) => {
        calls.tradeFee = payload;
        return [];
      },
      depositAddress: async (payload: object) => {
        calls.depositAddress = payload;
        return { address: "0x1", tag: "", coin: "USDT", url: "" };
      },
      allOrders: async (payload: object) => {
        calls.allOrders = payload;
        return [];
      },
    } as unknown as Parameters<typeof getBinanceWithdrawalLimits>[0];

    await getBinanceWithdrawalLimits(binanceApi);
    await getBinanceTradeFees(binanceApi);
    await getBinanceDepositAddress(binanceApi, { coin: "USDT", network: "ETH" });
    await getBinanceAllOrders(binanceApi, { symbol: "USDCUSDT" });

    expect(calls.privateRequest).to.deep.equal({ recvWindow: BINANCE_READ_RECV_WINDOW_MS });
    expect(calls.tradeFee).to.deep.equal({ recvWindow: BINANCE_READ_RECV_WINDOW_MS });
    expect(calls.depositAddress).to.deep.equal({
      coin: "USDT",
      network: "ETH",
      recvWindow: BINANCE_READ_RECV_WINDOW_MS,
    });
    expect(calls.allOrders).to.deep.equal({
      symbol: "USDCUSDT",
      recvWindow: BINANCE_READ_RECV_WINDOW_MS,
    });
  });

  it("applies the market-order recvWindow to signed order helpers", async function () {
    const calls: Record<string, unknown> = {};
    const binanceApi = {
      order: async (payload: object) => {
        calls.order = payload;
        return { status: "FILLED" };
      },
    } as unknown as Parameters<typeof submitBinanceOrder>[0];

    await submitBinanceOrder(binanceApi, {
      symbol: "USDCUSDT",
      side: "BUY",
      type: "MARKET",
      quantity: "1",
    } as Parameters<typeof submitBinanceOrder>[1]);

    expect(calls.order).to.deep.equal({
      symbol: "USDCUSDT",
      side: "BUY",
      type: "MARKET",
      quantity: "1",
      recvWindow: BINANCE_ORDER_RECV_WINDOW_MS,
    });
  });

  it("applies the withdrawal recvWindow to signed withdrawal helpers", async function () {
    const calls: Record<string, unknown> = {};
    const binanceApi = {
      withdraw: async (payload: object) => {
        calls.withdraw = payload;
        return { id: "withdrawal-id" };
      },
    } as unknown as Parameters<typeof submitBinanceWithdrawal>[0];

    await submitBinanceWithdrawal(binanceApi, {
      coin: "USDT",
      address: "0x1",
      network: "ETH",
      amount: 1,
      transactionFeeFlag: false,
    });

    expect(calls.withdraw).to.deep.equal({
      coin: "USDT",
      address: "0x1",
      network: "ETH",
      amount: 1,
      transactionFeeFlag: false,
      recvWindow: BINANCE_WITHDRAW_RECV_WINDOW_MS,
    });
  });
});

describe("BinanceUtils withdrawal helpers", function () {
  it("only treats completed Binance withdrawals as completed", function () {
    expect(isCompletedBinanceWithdrawal(6)).to.equal(true);
    expect(isCompletedBinanceWithdrawal(0)).to.equal(false);
    expect(isCompletedBinanceWithdrawal(2)).to.equal(false);
    expect(isCompletedBinanceWithdrawal(4)).to.equal(false);
    expect(isCompletedBinanceWithdrawal(5)).to.equal(false);
    expect(isCompletedBinanceWithdrawal(undefined)).to.equal(false);
  });
});

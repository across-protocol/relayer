import { expect, sinon } from "./utils";
import {
  BinanceDeposit,
  BinanceWithdrawal,
  createBinanceServerTimeSynchronizer,
  getOutstandingBinanceDeposits,
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

describe("BinanceUtils: createBinanceServerTimeSynchronizer", function () {
  it("reuses a cached server time offset between refreshes", async function () {
    let nowMs = 1_000;
    const fetchServerTime = sinon.stub().resolves(5_000);
    const synchronizer = createBinanceServerTimeSynchronizer(fetchServerTime, {
      now: () => nowMs,
      syncIntervalMs: 100,
    });

    expect(await synchronizer.getTime()).to.equal(5_000);
    nowMs = 1_050;
    expect(await synchronizer.getTime()).to.equal(5_050);
    expect(fetchServerTime.callCount).to.equal(1);
  });

  it("refreshes the cached offset after the sync interval elapses", async function () {
    let nowMs = 1_000;
    const fetchServerTime = sinon.stub();
    fetchServerTime.onFirstCall().resolves(5_000);
    fetchServerTime.onSecondCall().resolves(6_000);
    const synchronizer = createBinanceServerTimeSynchronizer(fetchServerTime, {
      now: () => nowMs,
      syncIntervalMs: 100,
    });

    expect(await synchronizer.getTime()).to.equal(5_000);
    nowMs = 1_250;
    expect(await synchronizer.getTime()).to.equal(6_000);
    expect(fetchServerTime.callCount).to.equal(2);
  });

  it("anchors the offset to response receipt time so asymmetric latency does not push timestamps ahead", async function () {
    let nowMs = 1_000;
    const fetchServerTime = sinon.stub().callsFake(async () => {
      nowMs = 1_040;
      return 5_020;
    });
    const synchronizer = createBinanceServerTimeSynchronizer(fetchServerTime, {
      now: () => nowMs,
      syncIntervalMs: 100,
    });

    expect(await synchronizer.getTime()).to.equal(5_020);
    nowMs = 1_060;
    expect(await synchronizer.getTime()).to.equal(5_040);
    expect(fetchServerTime.callCount).to.equal(1);
  });

  it("resyncs if the local wall clock moves backward", async function () {
    let nowMs = 1_000;
    const fetchServerTime = sinon.stub();
    fetchServerTime.onFirstCall().resolves(5_000);
    fetchServerTime.onSecondCall().resolves(4_900);
    const synchronizer = createBinanceServerTimeSynchronizer(fetchServerTime, {
      now: () => nowMs,
      syncIntervalMs: 100,
    });

    expect(await synchronizer.getTime()).to.equal(5_000);
    nowMs = 900;
    expect(await synchronizer.getTime()).to.equal(4_900);
    expect(fetchServerTime.callCount).to.equal(2);
  });
});

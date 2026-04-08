import { expect } from "./utils";
import { isFailedBinanceWithdrawal, isTerminalBinanceWithdrawal } from "../src/rebalancer/adapters/binance";

describe("Binance adapter withdrawal state", function () {
  it("treats terminal Binance withdrawal failures as failed", function () {
    expect(isFailedBinanceWithdrawal(1)).to.equal(true);
    expect(isFailedBinanceWithdrawal(3)).to.equal(true);
    expect(isFailedBinanceWithdrawal(5)).to.equal(true);
  });

  it("does not treat in-flight or completed Binance withdrawals as failed", function () {
    expect(isFailedBinanceWithdrawal(0)).to.equal(false);
    expect(isFailedBinanceWithdrawal(2)).to.equal(false);
    expect(isFailedBinanceWithdrawal(4)).to.equal(false);
    expect(isFailedBinanceWithdrawal(6)).to.equal(false);
    expect(isFailedBinanceWithdrawal(undefined)).to.equal(false);
  });

  it("only treats terminal Binance withdrawals as terminal", function () {
    expect(isTerminalBinanceWithdrawal(1)).to.equal(true);
    expect(isTerminalBinanceWithdrawal(3)).to.equal(true);
    expect(isTerminalBinanceWithdrawal(5)).to.equal(true);
    expect(isTerminalBinanceWithdrawal(6)).to.equal(true);
    expect(isTerminalBinanceWithdrawal(0)).to.equal(false);
    expect(isTerminalBinanceWithdrawal(2)).to.equal(false);
    expect(isTerminalBinanceWithdrawal(4)).to.equal(false);
    expect(isTerminalBinanceWithdrawal(undefined)).to.equal(false);
  });
});

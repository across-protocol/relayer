import { assertBinanceWithdrawalRoute } from "../src/adapter/bridges";
import { Coin } from "../src/utils";
import { expect, toBNWei } from "./utils";

const USDT_DECIMALS = 6;
const usdt = (amount: string) => toBNWei(amount, USDT_DECIMALS);

// Minimal `accountCoins` shape: only the fields the guard reads.
const coins = (overrides: Partial<{ withdrawEnable: boolean; withdrawMin: string; withdrawMax: string }> = {}) =>
  [
    {
      symbol: "USDT",
      balance: "0",
      networkList: [
        {
          name: "AVAXC",
          coin: "USDT",
          withdrawMin: overrides.withdrawMin ?? "10",
          withdrawMax: overrides.withdrawMax ?? "1000000",
          withdrawFee: "1",
          contractAddress: "0x",
          withdrawEnable: overrides.withdrawEnable,
        },
      ],
    },
  ] as unknown as Coin[];

describe("SameAssetRebalancer_Binance withdrawal guard", function () {
  it("permits a withdrawable route", function () {
    expect(() => assertBinanceWithdrawalRoute(coins(), "USDT", "AVAXC", usdt("20000"), USDT_DECIMALS)).to.not.throw();
  });

  it("treats an absent withdrawEnable flag as enabled", function () {
    // Binance omits the flag on some responses; a missing flag is not evidence of suspension.
    expect(() =>
      assertBinanceWithdrawalRoute(coins({ withdrawEnable: undefined }), "USDT", "AVAXC", usdt("20000"), USDT_DECIMALS)
    ).to.not.throw();
  });

  it("rejects a suspended coin/network pair", function () {
    expect(() =>
      assertBinanceWithdrawalRoute(coins({ withdrawEnable: false }), "USDT", "AVAXC", usdt("20000"), USDT_DECIMALS)
    ).to.throw(/suspended USDT withdrawals on AVAXC/);
  });

  it("rejects a network Binance does not list for the coin", function () {
    expect(() => assertBinanceWithdrawalRoute(coins(), "USDT", "BSC", usdt("20000"), USDT_DECIMALS)).to.throw(
      /lists no USDT route on BSC/
    );
  });

  it("rejects amounts outside the withdrawal bounds", function () {
    expect(() => assertBinanceWithdrawalRoute(coins(), "USDT", "AVAXC", usdt("5"), USDT_DECIMALS)).to.throw(
      /below the .* withdrawal minimum/
    );
    expect(() =>
      assertBinanceWithdrawalRoute(coins({ withdrawMax: "100" }), "USDT", "AVAXC", usdt("20000"), USDT_DECIMALS)
    ).to.throw(/exceeds the .* withdrawal maximum/);
  });
});

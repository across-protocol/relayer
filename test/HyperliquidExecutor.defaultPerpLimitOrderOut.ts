import { expect } from "./utils";
import { toBN } from "../src/utils";
import { defaultPerpLimitOrderOut } from "../src/hyperliquid/HyperliquidExecutor";

// USDC on Hypercore: weiDecimals = 8, perp accounting = 6 decimals => granularity 100.
const WEI_DECIMALS = 8;
const max = toBN("452000000000"); // Structurally representable (derived from a 6-decimal EVM amount).
const cleanMin = toBN("451840899900");
const dustyMin = toBN("451840899951"); // Non-sponsored min is slippage-scaled and can be dusty.

describe("defaultPerpLimitOrderOut", function () {
  it("submits max when the market out exceeds it, letting the contract cap", function () {
    expect(defaultPerpLimitOrderOut(max.add(12345), cleanMin, max, WEI_DECIMALS)?.toString()).to.equal(max.toString());
    expect(defaultPerpLimitOrderOut(max.add(1), cleanMin, max, WEI_DECIMALS)?.toString()).to.equal(max.toString());
  });

  it("refuses to finalize above a non-representable max", function () {
    const dustyMax = max.add(50);
    expect(defaultPerpLimitOrderOut(dustyMax.add(1000), cleanMin, dustyMax, WEI_DECIMALS)).to.be.undefined;
  });

  it("floors in-range outputs to the representable granularity", function () {
    // Regression: the Aug 2026 stuck finalizations submitted raw outputs; Hypercore rejected e.g. 451840899999
    // with "Invalid send" while 451840900000 was delivered.
    expect(defaultPerpLimitOrderOut(toBN("451840999999"), cleanMin, max, WEI_DECIMALS)?.toString()).to.equal(
      "451840999900"
    );
    // Already-representable outputs are unchanged.
    expect(defaultPerpLimitOrderOut(toBN("451840999900"), cleanMin, max, WEI_DECIMALS)?.toString()).to.equal(
      "451840999900"
    );
  });

  it("submits below a representable min, letting the contract top up from the donation box", function () {
    expect(defaultPerpLimitOrderOut(toBN("450000000001"), cleanMin, max, WEI_DECIMALS)?.toString()).to.equal(
      "450000000000"
    );
    // Sponsored orders (min == max) resolve to the representable min on the contract side.
    expect(defaultPerpLimitOrderOut(toBN("451999999999"), max, max, WEI_DECIMALS)?.toString()).to.equal("451999999900");
  });

  it("refuses to finalize below a non-representable min", function () {
    // The contract would top the send up to exactly min, which is not representable, so the send would fail after
    // the swap is marked finalized.
    expect(defaultPerpLimitOrderOut(toBN("450000000001"), dustyMin, max, WEI_DECIMALS)).to.be.undefined;
    // Same when the floored output dips below min even though the raw output is above it.
    expect(defaultPerpLimitOrderOut(toBN("451840899999"), dustyMin, max, WEI_DECIMALS)).to.be.undefined;
  });

  it("is a pure clamp for tokens whose weiDecimals do not exceed perp accounting decimals", function () {
    const min6 = toBN("4518408999");
    const max6 = toBN("4520000000");
    expect(defaultPerpLimitOrderOut(toBN("4519000001"), min6, max6, 6)?.toString()).to.equal("4519000001");
    expect(defaultPerpLimitOrderOut(toBN("4518408998"), min6, max6, 6)?.toString()).to.equal("4518408998");
    expect(defaultPerpLimitOrderOut(max6.add(1), min6, max6, 6)?.toString()).to.equal(max6.toString());
  });
});

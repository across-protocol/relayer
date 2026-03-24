import { expect } from "./utils";
import { floatToBN } from "../src/utils/BNUtils";

describe("floatToBN", function () {
  it("Integer input", function () {
    expect(floatToBN(100, 6).toString()).to.equal("100000000");
    expect(floatToBN(100, 18).toString()).to.equal("100000000000000000000");
    expect(floatToBN(0, 18).toString()).to.equal("0");
    expect(floatToBN(1, 0).toString()).to.equal("1");
  });

  it("Simple decimal input", function () {
    expect(floatToBN(0.5, 18).toString()).to.equal("500000000000000000");
    expect(floatToBN(1.5, 6).toString()).to.equal("1500000");
    // Number(99.99) is not exactly representable in IEEE 754; use string for exact values.
    expect(floatToBN("99.99", 6).toString()).to.equal("99990000");
  });

  it("Many decimal digits without exceeding MAX_SAFE_INTEGER", function () {
    // This was the original failing case: 13 fractional digits would cause
    // Number(float) * 10^13 to exceed Number.MAX_SAFE_INTEGER.
    const result = floatToBN(5654.8610313399695, 18);
    // The integer part scaled to 18 decimals: 5654 * 10^18 = 5654000000000000000000
    // Should be in the right ballpark.
    expect(result.gt(0)).to.be.true;
    expect(result.toString().startsWith("5654")).to.be.true;
  });

  it("Very small numbers (scientific notation)", function () {
    // JavaScript renders 0.000000001234 as "1.234e-9" via String(), so the
    // function must handle that without throwing.
    const result = floatToBN(0.000000001234, 18);
    expect(result.toString()).to.equal("1234000000");

    const result2 = floatToBN(1e-10, 18);
    expect(result2.toString()).to.equal("100000000");
  });

  it("String input bypasses toFixed", function () {
    expect(floatToBN("0.001", 18).toString()).to.equal("1000000000000000");
    expect(floatToBN("100", 6).toString()).to.equal("100000000");
    expect(floatToBN("5654.8610313399695", 18).toString()).to.equal("5654861031339969500000");
  });

  it("Precision smaller than fractional digits truncates via ConvertDecimals", function () {
    // 1.123456789 has 9 fractional digits, precision=6 → ConvertDecimals(9, 6) divides by 10^3.
    expect(floatToBN("1.123456789", 6).toString()).to.equal("1123456");
  });

  it("Large integer input", function () {
    expect(floatToBN(1000000, 6).toString()).to.equal("1000000000000");
  });
});

import { expect } from "./utils";
import { floatToBN } from "../src/utils/BNUtils";

describe("floatToBN", function () {
  it("scales integer inputs to the requested precision", function () {
    expect(floatToBN(100, 6).toString()).to.equal("100000000");
    expect(floatToBN(100, 18).toString()).to.equal("100000000000000000000");
    expect(floatToBN(0, 18).toString()).to.equal("0");
    expect(floatToBN(1, 0).toString()).to.equal("1");
  });

  it("scales simple decimal inputs", function () {
    expect(floatToBN(0.5, 18).toString()).to.equal("500000000000000000");
    expect(floatToBN(1.5, 6).toString()).to.equal("1500000");
    // Number(99.99) is not exactly representable in IEEE 754; use string for exact values.
    expect(floatToBN("99.99", 6).toString()).to.equal("99990000");
  });

  it("handles number inputs with many fractional digits", function () {
    // The parser should scale the rendered decimal digits directly instead of
    // relying on unsafe JS number multiplication.
    const result = floatToBN(5654.8610313399695, 18);
    expect(result.gt(0)).to.be.true;
    expect(result.toString().startsWith("5654")).to.be.true;
  });

  it("handles scientific notation produced from small number inputs", function () {
    // JavaScript renders 0.000000001234 as "1.234e-9" via String(), so the
    // function must handle that without throwing.
    const result = floatToBN(0.000000001234, 18);
    expect(result.toString()).to.equal("1234000000");

    const result2 = floatToBN(1e-10, 18);
    expect(result2.toString()).to.equal("100000000");
  });

  it("handles scientific notation string inputs", function () {
    expect(floatToBN("1e-10", 18).toString()).to.equal("100000000");
    expect(floatToBN("1.234e-9", 18).toString()).to.equal("1234000000");
    expect(floatToBN("1.23e+25", 6).toString()).to.equal("12300000000000000000000000000000");
  });

  it("preserves exact decimal string inputs", function () {
    expect(floatToBN("0.001", 18).toString()).to.equal("1000000000000000");
    expect(floatToBN("100", 6).toString()).to.equal("100000000");
    expect(floatToBN("5654.8610313399695", 18).toString()).to.equal("5654861031339969500000");
  });

  it("handles very long decimal strings", function () {
    expect(floatToBN("1.123456789012345678901234567890", 18).toString()).to.equal("1123456789012345678");
    expect(floatToBN("0.0000000000000000000000000001234567890123456789", 36).toString()).to.equal("123456789");
  });

  it("truncates extra fractional digits when precision is lower", function () {
    // 1.123456789 has 9 fractional digits, precision=6 → drop the last 3 fractional digits.
    expect(floatToBN("1.123456789", 6).toString()).to.equal("1123456");
  });

  it("handles large integer inputs", function () {
    expect(floatToBN(1000000, 6).toString()).to.equal("1000000000000");
  });
});

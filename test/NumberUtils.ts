import { createDecimalAligner, formatFixedDecimals, truncate } from "../src/utils/NumberUtils";
import { expect } from "./utils";

describe("truncate", function () {
  it("truncates plain decimal inputs without rounding", function () {
    expect(truncate(1.239, 2)).to.equal(1.23);
    expect(truncate(9.999, 2)).to.equal(9.99);
  });

  it("supports zero decimal places", function () {
    expect(truncate(1.239, 0)).to.equal(1);
    expect(truncate(-1.239, 0)).to.equal(-1);
  });

  it("handles negative numbers", function () {
    expect(truncate(-1.239, 2)).to.equal(-1.23);
  });

  it("handles small numbers rendered in scientific notation", function () {
    expect(truncate(1.234e-7, 8)).to.equal(0.00000012);
    expect(truncate(-1.234e-7, 8)).to.equal(-0.00000012);
    expect(truncate(1e-10, 12)).to.equal(0.0000000001);
  });

  it("handles large numbers rendered in scientific notation", function () {
    expect(truncate(1.234e21, 2)).to.equal(1.234e21);
  });
});

describe("formatFixedDecimals", function () {
  it("renders every value with the same number of decimals", function () {
    expect(formatFixedDecimals("69539593700000000000000", 18, 2)).to.equal("69,539.59");
    expect(formatFixedDecimals("0", 18, 2)).to.equal("0.00");
    expect(formatFixedDecimals("5000000000000000", 18, 2)).to.equal("0.00"); // 0.005 truncates.
  });

  it("truncates rather than rounds", function () {
    expect(formatFixedDecimals("999999999999999999", 18, 2)).to.equal("0.99");
  });

  it("groups the integer part with commas", function () {
    expect(formatFixedDecimals("218878730000", 6, 2)).to.equal("218,878.73");
    expect(formatFixedDecimals("1234567890000000", 6, 2)).to.equal("1,234,567,890.00");
  });

  it("supports zero display decimals", function () {
    expect(formatFixedDecimals("69539593700000000000000", 18, 0)).to.equal("69,539");
  });
});

describe("createDecimalAligner", function () {
  it("aligns values of mixed precision on the decimal point", function () {
    const align = createDecimalAligner(["69,539.59", "0.000", "218,878.73"]);
    expect(align("69,539.59")).to.equal(" 69,539.59 ");
    expect(align("0.000")).to.equal("      0.000");
    expect(align("218,878.73")).to.equal("218,878.73 ");
  });

  it("pads all values to the same total width", function () {
    const values = ["1.2", "34.5678", "9", "1,000.00"];
    const align = createDecimalAligner(values);
    const widths = new Set(values.map((v) => align(v).length));
    expect(widths.size).to.equal(1);
  });

  it("right-aligns values without a decimal point to the integer column", function () {
    const align = createDecimalAligner(["123.45", "-"]);
    expect(align("-")).to.equal("  -   ");
    expect(align("123.45")).to.equal("123.45");
  });

  it("handles integer-only value sets", function () {
    const align = createDecimalAligner(["7", "1,000"]);
    expect(align("7")).to.equal("    7");
    expect(align("1,000")).to.equal("1,000");
  });
});

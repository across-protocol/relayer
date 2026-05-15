import { truncate } from "../src/utils/NumberUtils";
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

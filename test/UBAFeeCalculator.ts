import { BigNumber } from "ethers";
import { UBAPiecewiseFunction } from "../src/utils/UBAFeeCalculator";
import { expect } from "./utils";

describe("UBACalculator", async function () {
  let fn: UBAPiecewiseFunction<BigNumber>;

  beforeEach(async function () {
    fn = new UBAPiecewiseFunction<BigNumber>([]);
  });

  it("should throw an error if the function is not valid", async function () {
    fn.addElement({
      minRange: BigNumber.from(0),
      maxRange: BigNumber.from(10),
      fn: (x) => x,
    });
    fn.addElement({
      minRange: BigNumber.from(0),
      maxRange: BigNumber.from(20),
      fn: (x) => x,
    });
    expect(() => fn.apply(BigNumber.from(20))).to.throw("Piecewise function is not valid");
  });

  it("should throw an error if the value is out of range", async function () {
    fn.addElement({
      minRange: BigNumber.from(0),
      maxRange: BigNumber.from(10),
      fn: (x) => x,
    });
    expect(() => fn.apply(BigNumber.from(20))).to.throw("Value is not in the range of the piecewise function");
  });

  it("should return the correct value", async function () {
    fn.addElement({
      minRange: BigNumber.from(0),
      maxRange: BigNumber.from(10),
      fn: (x) => x,
    });
    fn.addElement({
      minRange: BigNumber.from(10),
      maxRange: BigNumber.from(20),
      fn: (x) => x.mul(2),
    });
    expect(fn.apply(BigNumber.from(5))).to.equal(BigNumber.from(5));
    expect(fn.apply(BigNumber.from(15))).to.equal(BigNumber.from(30));
  });
});

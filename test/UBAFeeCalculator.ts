import { expect } from "chai";
import { toBN } from "../src/utils";
import { UBAFeeConfig } from "../src/utils/UBAFeeCalculator";
import {
  getBounds,
  getDepositBalancingFee,
  getInterval,
  getRefundBalancingFee,
  performLinearIntegration,
} from "../src/utils/UBAFeeCalculator/UBAFeeUtility";
import { TupleParameter } from "../src/utils/UBAFeeCalculator/UBAFeeConfig";
import { MAX_SAFE_JS_INT } from "@uma/common";
import { parseEther, parseUnits } from "ethers/lib/utils";

describe("UBA Fee Calculations", () => {
  let config: UBAFeeConfig;
  let tuples: TupleParameter[];

  beforeEach(() => {
    config = new UBAFeeConfig(
      {
        default: toBN("300000000000000"),
      },
      toBN(0),
      {
        default: [
          [toBN("100000"), parseUnits("-0.4", 18)],
          [toBN("250000"), parseUnits("-0.25", 18)],
          [toBN("500000"), parseUnits("-0.1", 18)],
          [toBN("750000"), parseUnits("-0.01", 18)],
          [toBN("1000000"), parseUnits("-0.005", 18)],
          [toBN("1500000"), parseUnits("-0.0005", 18)],
          [toBN("2000000"), parseUnits("0.0", 18)],
          [toBN("4000000"), parseUnits("0.0", 18)],
          [toBN("5500000"), parseUnits("0.0005", 18)],
          [toBN("6000000"), parseUnits("0.005", 18)],
          [toBN("6500000"), parseUnits("0.01", 18)],
          [toBN("7000000"), parseUnits("0.1", 18)],
          [toBN("8000000"), parseUnits("0.25", 18)],
          [toBN("9000000"), parseUnits("0.4", 18)],
        ],
      }
    );
    tuples = config.getBalancingFeeTuples(0);
  });

  it("should accurately return the correct lower/upper bounds from a given index", () => {
    const [lowerBound, upperBound] = getBounds(tuples, 3);
    expect(lowerBound.toString()).to.eq(toBN("500000"));
    expect(upperBound.toString()).to.eq(toBN("750000"));
  });

  it("should return an expected interval for a given value", () => {
    const [idx, [lowerBound, upperBound]] = getInterval(tuples, toBN("12000000"));
    expect(idx).to.eq(14);
    expect(lowerBound.toString()).to.eq("9000000");
    expect(upperBound.toString()).to.eq(MAX_SAFE_JS_INT.toString());
  });

  it("should integrate the correct value: test #1", () => {
    const result = performLinearIntegration(tuples, 0, toBN(0), toBN(100_000));
    expect(result.div(parseEther("1")).toString()).to.eq("-40000");
  });

  it("should integrate the correct value: test #2", () => {
    const result = performLinearIntegration(tuples, 0, toBN(100_000), toBN(0));
    expect(result.div(parseEther("1")).toString()).to.eq("40000");
  });

  it("should integrate the correct value: test #3", () => {
    const result = performLinearIntegration(tuples, 1, toBN(100_000), toBN(250_000));
    expect(result.div(parseEther("1")).toString()).to.eq("-48750");
  });

  it("should integrate the correct value: test #4", () => {
    const result = performLinearIntegration(tuples, 1, toBN(250_000), toBN(100_000));
    expect(result.div(parseEther("1")).toString()).to.eq("48750");
  });

  it("should compute the correct deposit fee", () => {
    const result = getDepositBalancingFee(tuples, toBN(300_000), toBN(50_000));
    expect(result.div(parseEther("1")).toString()).to.eq("-10250");
  });

  it("should compute the correct refund fee", () => {
    const result = getRefundBalancingFee(tuples, toBN(350_000), toBN(50_000));
    expect(result.div(parseEther("1")).toString()).to.eq("10250");
  });
});

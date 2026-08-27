import {
  MULTICALL3_BATCH_GAS_CEILING,
  MULTICALL3_BATCH_GAS_MULTIPLIER,
  MULTICALL3_BATCH_GAS_OVERHEAD,
} from "../src/common/Constants";
import { Multicall2Call, planMulticall3Batch } from "../src/utils/Multicall3Utils";
import { BigNumber, expect, toBN } from "./utils";

const call = (n: number): Multicall2Call => ({ target: `0x${"11".repeat(20)}`, callData: `0x0${n}` });

// Estimator keyed on the call's index digit; an Error entry models a failing estimation.
function estimatorFor(estimates: (BigNumber | Error)[]): (call: Multicall2Call) => Promise<BigNumber | Error> {
  return async ({ callData }) => estimates[Number(String(callData).slice(-1))] ?? new Error("unknown call");
}

describe("planMulticall3Batch", function () {
  const budget =
    Math.floor(MULTICALL3_BATCH_GAS_CEILING / MULTICALL3_BATCH_GAS_MULTIPLIER) - MULTICALL3_BATCH_GAS_OVERHEAD;

  it("includes and sizes calls from their own estimates plus wrapper overhead", async function () {
    const plan = await planMulticall3Batch(estimatorFor([toBN(200_000), toBN(300_000)]), [call(0), call(1)]);
    expect(plan.included).to.deep.equal([0, 1]);
    expect(plan.gasLimit.eq(500_000 + MULTICALL3_BATCH_GAS_OVERHEAD)).to.be.true;
    expect(plan.failed).to.deep.equal([]);
    expect(plan.deferred).to.deep.equal([]);
  });

  it("drops calls that fail estimation, retaining the error", async function () {
    const error = new Error("execution reverted");
    const plan = await planMulticall3Batch(estimatorFor([toBN(200_000), error]), [call(0), call(1)]);
    expect(plan.included).to.deep.equal([0]);
    expect(plan.gasLimit.eq(200_000 + MULTICALL3_BATCH_GAS_OVERHEAD)).to.be.true;
    expect(plan.failed).to.deep.equal([{ index: 1, error }]);
    expect(plan.deferred).to.deep.equal([]);
  });

  it("defers calls that would exceed the gas budget", async function () {
    // Greedy in input order: 0 fits, 1 would overflow the budget, 2 still fits alongside 0.
    const big = toBN(budget).sub(100_000);
    const plan = await planMulticall3Batch(estimatorFor([big, big, toBN(100_000)]), [call(0), call(1), call(2)]);
    expect(plan.included).to.deep.equal([0, 2]);
    expect(plan.gasLimit.eq(big.add(100_000).add(MULTICALL3_BATCH_GAS_OVERHEAD))).to.be.true;
    expect(plan.deferred).to.deep.equal([1]);
    expect(plan.failed).to.deep.equal([]);
  });

  it("returns an empty plan for no calls", async function () {
    const plan = await planMulticall3Batch(estimatorFor([]), []);
    expect(plan.included).to.deep.equal([]);
    expect(plan.gasLimit.eq(MULTICALL3_BATCH_GAS_OVERHEAD)).to.be.true;
  });
});

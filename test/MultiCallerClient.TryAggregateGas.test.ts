import { Multicall3__factory } from "@across-protocol/sdk/src/utils/abi/typechain";
import { BigNumber, Contract } from "ethers";
import { MULTICALL3_BATCH_GAS_MULTIPLIER, MULTICALL3_TRY_AGGREGATE_GAS_MULTIPLIER } from "../src/common";
import { deployMulticall3, ethers, expect, getContractFactory } from "./utils";

// Characterises eth_estimateGas against a real Multicall3 batch, pinning the properties the finalizer's gas sizing
// relies on: a tryAggregate(requireSuccess=false) estimate is a floor rather than a requirement — it describes the
// cost of *failing*, because the outer call swallows inner reverts — while the same calls estimated as aggregate()
// yield a limit that covers the batch for real. See sizeTryAggregateBatch() in src/finalizer/index.ts.
describe("Multicall3 tryAggregate gas estimation", function () {
  let multicall3: Contract, burner: Contract, from: string, originalBlockGasLimit: BigNumber;

  // `rounds` sets each call's gas. One large call is the case that matters — the withheld 1/64 is then the
  // largest fraction of the batch — plus a heterogeneous batch and a uniform one to show it converging.
  const shapes: [string, number[]][] = [
    ["a single large call", [8000]],
    ["a large call among small ones", [20, 20, 8000, 20]],
    ["uniformly sized calls", [1000, 1000, 1000, 1000, 1000]],
  ];

  before(async function () {
    const [signer] = await ethers.getSigners();
    from = signer.address;
    await deployMulticall3(signer);
    multicall3 = new Contract("0xcA11bde05977b3631167028862bE2a173976CA11", Multicall3__factory.abi, signer);
    burner = await (await getContractFactory("MockGasBurner", signer)).deploy();

    // @dev estimateGas probes near the block gas limit when the cheap path reverts, and the default 60M exceeds the
    // 16,777,216 cap the in-process EVM enforces on a single transaction, which surfaces as a provider error rather
    // than an estimate. Estimation is what's under test, so cap the block instead.
    originalBlockGasLimit = (await ethers.provider.getBlock("latest")).gasLimit;
    await ethers.provider.send("evm_setBlockGasLimit", ["0xF42400"]); // 16,000,000
  });

  after(async function () {
    await ethers.provider.send("evm_setBlockGasLimit", [originalBlockGasLimit.toHexString()]);
  });

  // The lowest limit at which every inner call of a tryAggregate batch actually reports success: the batch's real
  // requirement, as opposed to what estimateGas reports.
  const allSucceed = async (data: string, gasLimit: number, calls: number): Promise<boolean> => {
    try {
      const returned = await ethers.provider.call({ to: multicall3.address, data, from, gasLimit });
      const [results] = multicall3.interface.decodeFunctionResult("tryAggregate", returned);
      return results.length === calls && results.every((r: { success: boolean }) => r.success);
    } catch {
      return false;
    }
  };

  const bisect = async (data: string, calls: number): Promise<number> => {
    let [lo, hi] = [21_000, 12_000_000];
    expect(await allSucceed(data, hi, calls), "batch should fit inside the bisection ceiling").to.be.true;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (await allSucceed(data, mid, calls)) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    return hi;
  };

  const estimate = async (data: string): Promise<number> =>
    (await ethers.provider.estimateGas({ to: multicall3.address, data, from })).toNumber();

  const encode = (method: string, calls: { target: string; callData: string }[]): string =>
    multicall3.interface.encodeFunctionData(method, method === "aggregate" ? [calls] : [false, calls]);

  shapes.forEach(([label, rounds]) => {
    it(`Sizes a batch with ${label} past its true requirement`, async function () {
      const calls = rounds.map((r) => ({
        target: burner.address,
        callData: burner.interface.encodeFunctionData("burn", [r]),
      }));
      const tryData = encode("tryAggregate", calls);
      const required = await bisect(tryData, calls.length);

      // The tryAggregate() estimate is a floor. `at.most` rather than `below`: the shortfall vanishes into rounding
      // once no single call dominates.
      const tryEstimate = await estimate(tryData);
      expect(tryEstimate, `tryAggregate estimate ${tryEstimate} should not exceed ${required}`).to.be.at.most(required);

      // Estimated as aggregate(), the same calls yield a limit that already covers the requirement.
      const aggEstimate = await estimate(encode("aggregate", calls));
      expect(aggEstimate, `aggregate estimate ${aggEstimate} should cover ${required}`).to.be.at.least(required);

      const sized = Math.floor(aggEstimate * MULTICALL3_BATCH_GAS_MULTIPLIER);
      expect(await allSucceed(tryData, sized, calls.length), `batch should succeed at ${sized}`).to.be.true;
    });
  });

  // The case no multiplier can reach, and the reason the finalizer sizes with aggregate(). OP-stack finalization
  // gates on `gasleft() >= minGas * 64/63`, where minGas was declared by the withdrawal on L2 (~5.4M for Across)
  // rather than derived from what the call spends — so the shortfall is not the EIP-150 reserve, and is not bounded
  // by it. Mirrors the 2026-08-05 stall of an Optimism USDT and a Mode ETH withdrawal.
  it("Sizes a batch whose gas requirement exceeds its consumption", async function () {
    const minGas = 3_000_000;
    const calls = [{ target: burner.address, callData: burner.interface.encodeFunctionData("requireGas", [minGas]) }];
    const tryData = encode("tryAggregate", calls);
    const required = await bisect(tryData, calls.length);
    expect(required, `requirement ${required} should exceed minGas ${minGas}`).to.be.at.least(minGas);

    // The gate is invisible to an estimator that only observes consumption: the reverting path is cheap, so the
    // estimate settles two orders of magnitude below the requirement.
    const tryEstimate = await estimate(tryData);
    expect(tryEstimate, `tryAggregate estimate ${tryEstimate} should be far below ${required}`).to.be.below(
      required / 10
    );

    // Hence padding cannot close it — this is the behaviour that mined no-op batches.
    const padded = Math.floor(tryEstimate * MULTICALL3_TRY_AGGREGATE_GAS_MULTIPLIER);
    expect(await allSucceed(tryData, padded, calls.length), `padded ${padded} should still fail`).to.be.false;

    // aggregate() sees the gate, because there an inner revert is fatal to the outer call.
    const aggEstimate = await estimate(encode("aggregate", calls));
    expect(aggEstimate, `aggregate estimate ${aggEstimate} should cover ${required}`).to.be.at.least(required);

    const sized = Math.floor(aggEstimate * MULTICALL3_BATCH_GAS_MULTIPLIER);
    expect(await allSucceed(tryData, sized, calls.length), `batch should succeed at ${sized}`).to.be.true;
  });

  // Sizing via aggregate() lets one bad call spoil the estimate, so the fallback has to hold up: a call that reverts
  // only in combination survives the pre-flight (which simulates each call alone), and must not drag the rest of the
  // batch back onto the tryAggregate floor. Summed per-call estimates are immune — each call is estimated alone.
  it("Sizes a batch containing a call that only reverts in combination", async function () {
    const minGas = 3_000_000;
    const gated = { target: burner.address, callData: burner.interface.encodeFunctionData("requireGas", [minGas]) };
    // `once()` succeeds the first time and reverts on every later call, so it passes a solo pre-flight but breaks any
    // batch that already contains it.
    const once = { target: burner.address, callData: burner.interface.encodeFunctionData("once", []) };
    const calls = [gated, once, once];
    const tryData = encode("tryAggregate", calls);

    // Each call passes when simulated alone, as the pre-flight does — nothing is dropped.
    for (const { target, callData } of calls) {
      await ethers.provider.call({ from: multicall3.address, to: target, data: callData });
    }

    // But the batch does not estimate as aggregate(): the duplicate reverts.
    let aggregateEstimable = true;
    try {
      await ethers.provider.estimateGas({ to: multicall3.address, data: encode("aggregate", calls), from });
    } catch {
      aggregateEstimable = false;
    }
    expect(aggregateEstimable, "aggregate() should not estimate once a call reverts in combination").to.be.false;

    // The fallback estimates each call alone and sums, so the gated call is still funded for real.
    const perCall = await Promise.all(
      calls.map(({ target, callData }) =>
        ethers.provider.estimateGas({ from: multicall3.address, to: target, data: callData }).then((g) => g.toNumber())
      )
    );
    const summed = Math.floor(perCall.reduce((a, b) => a + b, 0) * MULTICALL3_BATCH_GAS_MULTIPLIER);
    expect(summed, `summed ${summed} should cover the gate ${minGas}`).to.be.at.least(minGas);

    // The healthy calls land and only the duplicate fails — #3660's isolation, preserved.
    const returned = await ethers.provider.call({ to: multicall3.address, data: tryData, from, gasLimit: summed });
    const [results] = multicall3.interface.decodeFunctionResult("tryAggregate", returned);
    expect(
      results.map((r: { success: boolean }) => r.success),
      "the gated call and the first `once` should succeed; the duplicate should not"
    ).to.deep.equal([true, true, false]);
  });
});

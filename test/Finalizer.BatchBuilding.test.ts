import { Multicall3__factory } from "@across-protocol/sdk/src/utils/abi/typechain";
import { BigNumber, Contract } from "ethers";
import {
  MULTICALL3_BATCH_GAS_CEILING,
  MULTICALL3_BATCH_GAS_MULTIPLIER,
  MULTICALL3_BATCH_GAS_OVERHEAD,
  MULTICALL3_TRY_AGGREGATE_GAS_MULTIPLIER,
} from "../src/common";
import { buildFinalizationBatches, finalizationBatchTxn, submissionStatus } from "../src/finalizer";
import { Multicall2Call } from "../src/utils";
import { createSpyLogger, deployMulticall3, ethers, expect, getContractFactory } from "./utils";

// buildFinalizationBatches() sizes a tryAggregate() batch from its calls' own estimates rather than from an estimate
// of the batch, which tryAggregate() makes meaningless: it catches inner reverts, so a batch whose calls all ran out
// of gas still succeeds. These pin the properties that sizing relies on — the summed estimate plus a fixed wrapper
// allowance covers the batch (including the case no multiplier on a tryAggregate() estimate reaches: a call gated on
// gasleft() rather than on consumption), a batch over the ceiling is split rather than submitted whole, and a call
// that no longer estimates is batched away from the calls whose limit doesn't account for it.
describe("Finalizer batch building", function () {
  const { spyLogger: logger } = createSpyLogger();
  const chainId = 1;
  let multicall3: Contract, burner: Contract;

  const burnCall = (rounds: number): Multicall2Call => ({
    target: burner.address,
    callData: burner.interface.encodeFunctionData("burn", [rounds]),
  });

  // A call that reverts unless it is *given* `minGas`, while consuming almost none of it — the OP-stack
  // callWithMinGas shape, whose requirement an estimate of the batch cannot see.
  const gatedCall = (minGas: number): Multicall2Call => ({
    target: burner.address,
    callData: burner.interface.encodeFunctionData("requireGas", [minGas]),
  });

  const failingCall = (): Multicall2Call => ({
    target: burner.address,
    callData: burner.interface.encodeFunctionData("fail", []),
  });

  // A call that spends gas and only then reverts, so the gas is consumed rather than returned to the batch — the
  // shape that makes an unestimated call unsafe to charge against a limit summed from its neighbours.
  const burnThenFailCall = (rounds: number): Multicall2Call => ({
    target: burner.address,
    callData: burner.interface.encodeFunctionData("burnThenFail", [rounds]),
  });

  // The bare sum of the calls' standalone estimates — what buildFinalizationBatches() sizes from, before it adds the
  // allowance for the tryAggregate() wrapper.
  const sum = async (calls: Multicall2Call[]): Promise<BigNumber> => {
    const estimates = await Promise.all(
      calls.map(({ target, callData }) =>
        multicall3.provider.estimateGas({ from: multicall3.address, to: target, data: callData })
      )
    );
    return estimates.reduce((acc, gas) => acc.add(gas), BigNumber.from(0));
  };

  const rejects = async (promise: Promise<unknown>): Promise<boolean> => {
    try {
      await promise;
      return false;
    } catch {
      return true;
    }
  };

  // The per-call success flags tryAggregate() reports at a given limit — what actually landed, as opposed to
  // whether the outer transaction succeeded.
  const successFlags = async (calls: Multicall2Call[], gasLimit: BigNumber): Promise<boolean[]> => {
    const results = await multicall3.callStatic.tryAggregate(false, calls, { gasLimit });
    return results.map(({ success }: { success: boolean }) => success);
  };

  const padded = (gasLimit: BigNumber): BigNumber =>
    gasLimit.mul(Math.round(MULTICALL3_BATCH_GAS_MULTIPLIER * 100)).div(100);

  before(async function () {
    const [signer] = await ethers.getSigners();
    await deployMulticall3(signer);
    multicall3 = new Contract("0xcA11bde05977b3631167028862bE2a173976CA11", Multicall3__factory.abi, signer);
    burner = await (await getContractFactory("MockGasBurner", signer)).deploy();

    // @dev The gated cases below depend on hardhat.config.ts holding blockGasLimit under EIP-7825's per-transaction
    // cap: estimateGas bisects towards the block gas limit for a call gated on gasleft(), and a probe above the cap
    // errors instead of estimating, which would silently size those calls at zero.
    expect((await ethers.provider.getBlock("latest")).gasLimit.toNumber()).to.be.at.most(16_777_216);
  });

  it("Returns a batch that fits as one transaction, sized", async function () {
    const calls = [burnCall(20), burnCall(2000), burnCall(20)];
    const batches = await buildFinalizationBatches(logger, chainId, multicall3, calls);

    expect(batches.length).to.equal(1);
    expect(batches[0].calls).to.deep.equal(calls);
    expect(batches[0].gasLimit).to.exist;
    expect(batches[0].gasLimit.lte(MULTICALL3_BATCH_GAS_CEILING)).to.be.true;
  });

  it("Sizes a batch high enough for every call to land", async function () {
    const calls = [burnCall(20), burnCall(2000), burnCall(500)];
    const [{ gasLimit }] = await buildFinalizationBatches(logger, chainId, multicall3, calls);

    expect(await successFlags(calls, padded(gasLimit))).to.deep.equal([true, true, true]);
  });

  // The regression this whole approach exists for. A tryAggregate() estimate of this batch describes the cost of the
  // calls *failing*, so it lands far below the requirement and no multiplier on it reaches — while the per-call
  // estimates see each gate directly.
  it("Sizes a batch whose calls gate on gasleft() rather than consumption", async function () {
    const minGas = 3_000_000;
    const calls = [gatedCall(minGas), burnCall(20), gatedCall(minGas)];

    const estimate = await multicall3.provider.estimateGas({
      from: multicall3.address,
      to: multicall3.address,
      data: multicall3.interface.encodeFunctionData("tryAggregate", [false, calls]),
    });
    // The estimate of the batch is a floor: padding it does not reach the gates.
    expect(await successFlags(calls, estimate.mul(3).div(2))).to.deep.equal([false, true, false]);

    const [{ gasLimit }] = await buildFinalizationBatches(logger, chainId, multicall3, calls);
    expect(gasLimit.gt(estimate.mul(3).div(2))).to.be.true;
    expect(await successFlags(calls, padded(gasLimit))).to.deep.equal([true, true, true]);
  });

  // Multicall3 forwards 63/64 of its remaining gas to each call, so for a single call the summed estimate is short
  // by more than the intrinsic gas it carries.
  it("Sizes a single large call, whose bare sum is short", async function () {
    const calls = [gatedCall(3_000_000)];
    const [{ gasLimit }] = await buildFinalizationBatches(logger, chainId, multicall3, calls);

    expect(await successFlags(calls, await sum(calls))).to.deep.equal([false]);
    expect(await successFlags(calls, padded(gasLimit))).to.deep.equal([true]);
  });

  // A batch of several calls covers the tryAggregate() wrapper incidentally, out of the 21,000 intrinsic gas each
  // standalone estimate carries and the batch pays once. A batch of one has no such slack, and the multiplier is
  // proportional to a sum that doesn't contain the wrapper — so a small lone call was supplied 53,650 against a
  // requirement of 54,870 and reverted the whole transaction. The fixed overhead, not the multiplier, covers this.
  it("Sizes a single small call, which no proportional multiplier would cover", async function () {
    const calls = [burnCall(20)];
    const [{ gasLimit }] = await buildFinalizationBatches(logger, chainId, multicall3, calls);

    const bare = await sum(calls);
    expect(
      bare
        .mul(Math.round(MULTICALL3_BATCH_GAS_MULTIPLIER * 100))
        .div(100)
        .lt(gasLimit)
    ).to.be.true;
    expect(await successFlags(calls, padded(gasLimit))).to.deep.equal([true]);
  });

  it("Splits a batch over the ceiling, keeping every transaction submittable", async function () {
    const minGas = 6_000_000;
    const calls = [gatedCall(minGas), gatedCall(minGas), gatedCall(minGas)];
    const batches = await buildFinalizationBatches(logger, chainId, multicall3, calls);

    expect(batches.length).to.be.greaterThan(1);
    // Batches partition the calls, in order.
    expect(batches.flatMap(({ calls }) => calls)).to.deep.equal(calls);
    for (const batch of batches) {
      expect(padded(batch.gasLimit).lte(MULTICALL3_BATCH_GAS_CEILING)).to.be.true;
      expect(await successFlags(batch.calls, padded(batch.gasLimit))).to.not.include(false);
    }
  });

  // A call that doesn't estimate has no size, so it can't be charged against a limit summed from other calls: it is
  // still submitted, but in a batch of its own, sized by the tryAggregate() fallback.
  it("Isolates a call that no longer estimates, leaving the sized batches sound", async function () {
    const healthy = [burnCall(20), burnCall(2000)];
    const [sized] = await buildFinalizationBatches(logger, chainId, multicall3, healthy);

    const withFailure = [healthy[0], failingCall(), healthy[1]];
    const batches = await buildFinalizationBatches(logger, chainId, multicall3, withFailure);

    // Every call is still submitted, in order, and nothing is dropped.
    expect(batches.flatMap(({ calls }) => calls)).to.deep.equal(withFailure);
    expect(batches.map(({ calls }) => calls.length)).to.deep.equal([1, 1, 1]);
    // The unestimated call carries no limit, so it falls back to the tryAggregate() multiplier.
    expect(batches[1].gasLimit).to.be.undefined;
    expect(finalizationBatchTxn(chainId, multicall3, batches[1]).gasLimitMultiplier).to.equal(
      MULTICALL3_TRY_AGGREGATE_GAS_MULTIPLIER
    );
    // Each healthy call is still sized from its own estimate and still lands; splitting them across transactions
    // costs one extra wrapper allowance, and nothing else.
    for (const batch of [batches[0], batches[2]]) {
      expect(await successFlags(batch.calls, padded(batch.gasLimit))).to.not.include(false);
    }
    expect(batches[0].gasLimit.add(batches[2].gasLimit).sub(sized.gasLimit).toNumber()).to.equal(
      MULTICALL3_BATCH_GAS_OVERHEAD
    );
  });

  // The regression the isolation exists for. tryAggregate() contains a revert, but not gas exhaustion: a call that
  // spends gas before reverting spends it out of the batch's limit, and a limit summed from the *other* calls doesn't
  // cover it. Sharing a batch, it starves the call after it and — given enough to burn — reverts the whole
  // transaction, which is the "mines and finalizes nothing" outcome this whole approach exists to avoid.
  it("Keeps an unestimated call that burns gas from taking a sized batch down with it", async function () {
    const healthy = [burnCall(20), burnCall(2000)];
    const heavy = burnThenFailCall(20_000);
    const calls = [healthy[0], heavy, healthy[1]];

    // Pin the premise: the burn-then-revert call really is unsizeable.
    expect(
      await rejects(
        multicall3.provider.estimateGas({ from: multicall3.address, to: heavy.target, data: heavy.callData })
      )
    ).to.be.true;

    // Shared with the healthy calls under a limit summed from them alone, it reverts the outer transaction.
    const [shared] = await buildFinalizationBatches(logger, chainId, multicall3, healthy);
    expect(await rejects(multicall3.callStatic.tryAggregate(false, calls, { gasLimit: padded(shared.gasLimit) }))).to.be
      .true;

    // Isolated, the healthy calls are untouched and the heavy call is confined to its own transaction.
    const batches = await buildFinalizationBatches(logger, chainId, multicall3, calls);
    expect(batches.flatMap(({ calls }) => calls)).to.deep.equal(calls);
    expect(batches[1].calls).to.deep.equal([heavy]);
    expect(batches[1].gasLimit).to.be.undefined;
    for (const batch of [batches[0], batches[2]]) {
      expect(await successFlags(batch.calls, padded(batch.gasLimit))).to.not.include(false);
    }
  });

  it("Groups consecutive unestimated calls rather than spending a transaction on each", async function () {
    const calls = [burnCall(20), failingCall(), failingCall(), burnCall(2000)];
    const batches = await buildFinalizationBatches(logger, chainId, multicall3, calls);

    expect(batches.flatMap(({ calls }) => calls)).to.deep.equal(calls);
    expect(batches.map(({ calls }) => calls.length)).to.deep.equal([1, 2, 1]);
    expect(batches[1].gasLimit).to.be.undefined;
    expect(batches[0].gasLimit).to.exist;
    expect(batches[2].gasLimit).to.exist;
  });

  it("Falls back to the tryAggregate() multiplier when no call in the batch estimates", async function () {
    const calls = [failingCall(), failingCall()];
    const batches = await buildFinalizationBatches(logger, chainId, multicall3, calls);

    expect(batches.length).to.equal(1);
    expect(batches[0].gasLimit).to.be.undefined;
    expect(finalizationBatchTxn(chainId, multicall3, batches[0]).gasLimitMultiplier).to.equal(
      MULTICALL3_TRY_AGGREGATE_GAS_MULTIPLIER
    );
  });

  it("Marks each batch nonMulticall so the bundler cannot merge them back", function () {
    const txn = finalizationBatchTxn(chainId, multicall3, { calls: [burnCall(20)], gasLimit: BigNumber.from(100_000) });

    expect(txn.nonMulticall).to.be.true;
    expect(txn.method).to.equal("tryAggregate");
    expect(txn.args[0]).to.be.false;
    expect(txn.gasLimitMultiplier).to.equal(MULTICALL3_BATCH_GAS_MULTIPLIER);
  });

  describe("submissionStatus()", function () {
    it("Reports a dropped message as unsubmitted", function () {
      const { submitted, reason } = submissionStatus(chainId, { dropped: true, submittedTxns: 1, expectedTxns: 1 });
      expect(submitted).to.be.false;
      expect(reason).to.contain("pre-flight");
    });

    it("Reports a chain that submitted nothing", function () {
      const { submitted, reason } = submissionStatus(chainId, { dropped: false, submittedTxns: 0, expectedTxns: 2 });
      expect(submitted).to.be.false;
      expect(reason).to.contain("no transaction submitted");
    });

    it("Reports a partially-submitted chain as unconfirmed", function () {
      const { submitted, reason } = submissionStatus(chainId, { dropped: false, submittedTxns: 1, expectedTxns: 3 });
      expect(submitted).to.be.false;
      expect(reason).to.contain("1/3");
    });

    it("Confirms a fully-submitted chain", function () {
      const { submitted, reason } = submissionStatus(chainId, { dropped: false, submittedTxns: 2, expectedTxns: 2 });
      expect(submitted).to.be.true;
      expect(reason).to.be.undefined;
    });
  });
});

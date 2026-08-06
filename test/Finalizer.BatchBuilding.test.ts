import { Multicall3__factory } from "@across-protocol/sdk/src/utils/abi/typechain";
import { BigNumber, Contract } from "ethers";
import { MULTICALL3_BATCH_GAS_CEILING, MULTICALL3_BATCH_GAS_MULTIPLIER } from "../src/common";
import { buildFinalizationBatches, finalizationBatchTxn, submissionStatus } from "../src/finalizer";
import { Multicall2Call } from "../src/utils";
import { createSpyLogger, deployMulticall3, ethers, expect, getContractFactory } from "./utils";

// buildFinalizationBatches() sizes a tryAggregate() batch from its calls' own estimates rather than from an estimate
// of the batch, which tryAggregate() makes meaningless: it catches inner reverts, so a batch whose calls all ran out
// of gas still succeeds. These pin the two properties that sizing relies on — the summed estimate covers the batch
// (including the case no multiplier on a tryAggregate() estimate reaches: a call gated on gasleft() rather than on
// consumption), and a batch over the ceiling is split rather than submitted whole.
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
  // by more than the intrinsic gas it carries. The multiplier, not the sum, is what covers that.
  it("Relies on the multiplier for a single call, whose bare sum is short", async function () {
    const calls = [gatedCall(3_000_000)];
    const [{ gasLimit }] = await buildFinalizationBatches(logger, chainId, multicall3, calls);

    expect(await successFlags(calls, gasLimit)).to.deep.equal([false]);
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

  it("Keeps a call that no longer estimates, contributing nothing to the size", async function () {
    const healthy = [burnCall(20), burnCall(2000)];
    const [sized] = await buildFinalizationBatches(logger, chainId, multicall3, healthy);

    const withFailure = [healthy[0], failingCall(), healthy[1]];
    const batches = await buildFinalizationBatches(logger, chainId, multicall3, withFailure);

    // The reverting call is still submitted — tryAggregate() isolates it — but adds nothing to the limit.
    expect(batches.length).to.equal(1);
    expect(batches[0].calls).to.deep.equal(withFailure);
    expect(batches[0].gasLimit.toString()).to.equal(sized.gasLimit.toString());
    expect(await successFlags(withFailure, padded(batches[0].gasLimit))).to.deep.equal([true, false, true]);
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

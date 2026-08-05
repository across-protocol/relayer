import { Multicall3__factory } from "@across-protocol/sdk/src/utils/abi/typechain";
import { BigNumber, Contract } from "ethers";
import { AugmentedTransaction, MultiCallerClient } from "../src/clients";
import { MULTICALL3_BATCH_GAS_CEILING, MULTICALL3_BATCH_GAS_MULTIPLIER } from "../src/common";
import { buildFinalizationBatches, finalizationBatchTxn, submissionStatus } from "../src/finalizer";
import { bnZero, Multicall2Call } from "../src/utils";
import { createSpyLogger, deployMulticall3, ethers, expect, getContractFactory } from "./utils";

// Reads the queues MultiCallerClient routes enqueued transactions into, to tell "submitted on its own" apart from
// "handed to the bundler".
class TestMultiCallerClient extends MultiCallerClient {
  queuedNonMulticallTxns(chainId: number): AugmentedTransaction[] {
    return this.nonMulticallTxns[chainId] ?? [];
  }

  queuedMulticallTxns(chainId: number): AugmentedTransaction[] {
    return this.txns[chainId] ?? [];
  }
}

// A batch over MULTICALL3_BATCH_GAS_CEILING must be split, or EIP-7825's 2^24 per-transaction cap rejects it whole.
// Run against real Multicall3 bytecode, so the sizing under test is the real thing.
describe("Finalizer batch building", function () {
  let multicall3: Contract, burner: Contract, logger: ReturnType<typeof createSpyLogger>["spyLogger"];
  const chainId = 1;

  // ~3.05M gas each, so a handful of them clears the ceiling while each batch stays estimable.
  const ROUNDS = 8000;

  const burnCalls = (count: number): Multicall2Call[] =>
    Array.from({ length: count }, () => ({
      target: burner.address,
      callData: burner.interface.encodeFunctionData("burn", [ROUNDS]),
    }));

  before(async function () {
    const [signer] = await ethers.getSigners();
    ({ spyLogger: logger } = createSpyLogger());
    await deployMulticall3(signer);
    multicall3 = new Contract("0xcA11bde05977b3631167028862bE2a173976CA11", Multicall3__factory.abi, signer);
    burner = await (await getContractFactory("MockGasBurner", signer)).deploy();
  });

  it("Leaves a batch that fits in one transaction alone", async function () {
    const calls = burnCalls(2);
    const batches = await buildFinalizationBatches(logger, chainId, multicall3, calls);

    expect(batches.length, "a batch under the ceiling should not be split").to.equal(1);
    expect(batches[0].calls).to.deep.equal(calls);
    expect(batches[0].gasLimit, "and should still be sized").to.not.be.undefined;
    expect(batches[0].gasLimit.toNumber()).to.be.at.most(
      Math.floor(MULTICALL3_BATCH_GAS_CEILING / MULTICALL3_BATCH_GAS_MULTIPLIER)
    );
  });

  it("Splits a batch that exceeds the ceiling, keeping every batch submittable", async function () {
    // Enough consumption to clear the ceiling: 6 x ~3.05M ~= 18.3M against a 15M ceiling.
    const calls = burnCalls(6);
    const batches = await buildFinalizationBatches(logger, chainId, multicall3, calls);

    expect(batches.length, "an oversized batch should be split").to.be.greaterThan(1);
    // 6 calls of ~3.06M against a ~13.6M budget pack to [4, 2]; bounded rather than pinned, but tight enough to
    // catch a regression into one call per batch.
    expect(batches.length, "and should not over-split").to.be.at.most(3);

    // Every batch is sized and its padded limit fits under the ceiling.
    batches.forEach(({ calls: batch, gasLimit }, idx) => {
      expect(batch.length, `batch ${idx} should not be empty`).to.be.greaterThan(0);
      expect(gasLimit, `batch ${idx} should be sized`).to.not.be.undefined;
      const padded = Math.floor(gasLimit.toNumber() * MULTICALL3_BATCH_GAS_MULTIPLIER);
      expect(padded, `batch ${idx} padded limit ${padded} should fit under the ceiling`).to.be.at.most(
        MULTICALL3_BATCH_GAS_CEILING
      );
    });

    // The batches partition the calls, in order.
    expect(batches.flatMap(({ calls: batch }) => batch)).to.deep.equal(calls);
  });

  it("Keeps every call succeeding at its batch's own gas limit", async function () {
    const calls = burnCalls(6);
    const batches = await buildFinalizationBatches(logger, chainId, multicall3, calls);
    const [{ address: from }] = await ethers.getSigners();

    for (const [idx, { calls: batch, gasLimit }] of batches.entries()) {
      const data = multicall3.interface.encodeFunctionData("tryAggregate", [false, batch]);
      const padded = Math.floor(gasLimit.toNumber() * MULTICALL3_BATCH_GAS_MULTIPLIER);
      const returned = await ethers.provider.call({ to: multicall3.address, data, from, gasLimit: padded });
      const [results] = multicall3.interface.decodeFunctionResult("tryAggregate", returned);
      expect(
        results.map((r: { success: boolean }) => r.success),
        `every call in batch ${idx} should succeed at ${padded}`
      ).to.deep.equal(batch.map(() => true));
    }
  });

  // A split that MultiCallerClient bundles back up is no split at all. The finalizer's client has no signer, so it
  // can't reach a multisender and would wrap same-contract transactions in multicall(bytes[]) — absent from
  // Multicall3, so encoding throws and the chain's whole batch is abandoned rather than submitted in pieces.
  it("Submits each batch as its own transaction", async function () {
    const batches = await buildFinalizationBatches(logger, chainId, multicall3, burnCalls(6));
    expect(batches.length, "test needs a split batch to have anything to bundle").to.be.greaterThan(1);

    // Signerless, exactly as finalize() constructs it.
    const multicallerClient = new TestMultiCallerClient(logger);
    const txns = batches.map((batch) => finalizationBatchTxn(chainId, multicall3, batch));
    txns.forEach((txn) => multicallerClient.enqueueTransaction(txn));

    expect(
      multicallerClient.queuedNonMulticallTxns(chainId),
      "every batch should be queued for its own txn"
    ).to.have.lengthOf(batches.length);
    expect(multicallerClient.queuedMulticallTxns(chainId), "and none should be queued for bundling").to.be.empty;

    // The reason that matters: bundling them produces a call Multicall3 has no function for, so the batch dies on
    // encoding at submission rather than going out in pieces.
    const bundled = await multicallerClient.buildMultiCallBundles(txns);
    expect(bundled, "the bundler would have merged the batches back together").to.have.lengthOf(1);
    expect(bundled[0].method).to.equal("multicall");
    expect(() => multicall3.interface.encodeFunctionData(bundled[0].method, bundled[0].args)).to.throw(
      "no matching function"
    );
  });

  // Packing counts per-call estimates while each batch is sized as aggregate(), so the split is only conservative if
  // the per-call sum runs at or above what the batch estimates at. It does, by a wide margin: each per-call estimate
  // carries its own intrinsic and cold-access gas that aggregate() pays once. Pinned, because nothing downstream
  // rechecks it.
  describe("Packing is conservative against the batch's own estimate", function () {
    let originalBlockGasLimit: BigNumber;

    before(async function () {
      // @dev estimateGas probes near the block gas limit, and the default 60M exceeds the in-process EVM's 2^24
      // per-transaction cap, erroring instead of estimating.
      originalBlockGasLimit = (await ethers.provider.getBlock("latest")).gasLimit;
      await ethers.provider.send("evm_setBlockGasLimit", ["0xF42400"]); // 16,000,000
    });

    after(async function () {
      await ethers.provider.send("evm_setBlockGasLimit", [originalBlockGasLimit.toHexString()]);
    });

    (
      [
        ["many small calls", 50, 100],
        ["fewer large calls", 20, 2000],
      ] as [string, number, number][]
    ).forEach(([label, count, rounds]) => {
      it(label, async function () {
        const calls = Array.from({ length: count }, () => ({
          target: burner.address,
          callData: burner.interface.encodeFunctionData("burn", [rounds]),
        }));

        const summed = (
          await Promise.all(
            calls.map(({ target, callData }) =>
              ethers.provider.estimateGas({ from: multicall3.address, to: target, data: callData })
            )
          )
        ).reduce((acc, gas) => acc.add(gas), bnZero);
        const aggregated = await multicall3.estimateGas.aggregate(calls);

        expect(
          summed.gte(aggregated),
          `summed per-call estimate ${summed} should not undercut the aggregate estimate ${aggregated}`
        ).to.be.true;
      });
    });
  });
});

describe("Finalizer submission reporting", function () {
  const chainId = 1;

  it("Reports a fully-submitted chain as submitted", function () {
    expect(submissionStatus(chainId, { dropped: false, submittedTxns: 3, expectedTxns: 3 })).to.deep.equal({
      submitted: true,
    });
  });

  it("Reports a pre-flight drop as dropped", function () {
    const { submitted, reason } = submissionStatus(chainId, { dropped: true, submittedTxns: 2, expectedTxns: 2 });
    expect(submitted).to.be.false;
    expect(reason).to.contain("pre-flight");
  });

  it("Reports a chain that submitted nothing", function () {
    const { submitted, reason } = submissionStatus(chainId, { dropped: false, submittedTxns: 0, expectedTxns: 2 });
    expect(submitted).to.be.false;
    expect(reason).to.equal("no transaction submitted ⚠️");
  });

  // The case the split introduces: TransactionClient#submit stops at the first failure and returns the hashes it
  // already has, so a chain can come back with some batches landed and the rest never sent. Crediting every message on
  // the chain to the surviving hash would report finalizations that never went out as complete.
  it("Refuses to claim success when only some of a chain's transactions were submitted", function () {
    const { submitted, reason } = submissionStatus(chainId, { dropped: false, submittedTxns: 1, expectedTxns: 3 });
    expect(submitted, "a partial submission is not a success").to.be.false;
    expect(reason).to.contain("1/3");
    expect(reason).to.contain("may not be in one of them");
  });
});

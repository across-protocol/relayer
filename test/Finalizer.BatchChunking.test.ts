import { Multicall3__factory } from "@across-protocol/sdk/src/utils/abi/typechain";
import { Contract } from "ethers";
import { MULTICALL3_BATCH_GAS_CEILING, MULTICALL3_BATCH_GAS_MULTIPLIER } from "../src/common";
import { chunkFinalizationBatch } from "../src/finalizer";
import { Multicall2Call } from "../src/utils";
import { createSpyLogger, deployMulticall3, ethers, expect, getContractFactory } from "./utils";

// EIP-7825 caps a single transaction at 2^24 = 16,777,216 gas, so a finalization batch that outgrows
// MULTICALL3_BATCH_GAS_CEILING has to be split rather than sent whole and rejected. Exercised against real Multicall3
// bytecode, so the sizing the chunking depends on is the real thing.
describe("Finalizer batch chunking", function () {
  let multicall3: Contract, burner: Contract, logger: ReturnType<typeof createSpyLogger>["spyLogger"];
  const chainId = 1;

  // ~3.05M gas each, so a handful of them clears the ceiling while each chunk stays estimable.
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
    const batches = await chunkFinalizationBatch(logger, chainId, multicall3, calls);

    expect(batches.length, "a batch under the ceiling should not be split").to.equal(1);
    expect(batches[0].calls).to.deep.equal(calls);
    expect(batches[0].gasLimit, "and should still be sized").to.not.be.undefined;
    expect(batches[0].gasLimit.toNumber()).to.be.at.most(
      Math.floor(MULTICALL3_BATCH_GAS_CEILING / MULTICALL3_BATCH_GAS_MULTIPLIER)
    );
  });

  it("Splits a batch that exceeds the ceiling, keeping every chunk submittable", async function () {
    // Enough consumption to clear the ceiling: 6 x ~3.05M ~= 18.3M against a 15M ceiling.
    const calls = burnCalls(6);
    const batches = await chunkFinalizationBatch(logger, chainId, multicall3, calls);

    expect(batches.length, "an oversized batch should be split").to.be.greaterThan(1);
    // Packing is greedy, so 6 calls of ~3.06M against a ~13.6M budget come out as [4, 2]. Bounded rather than pinned
    // exactly, but tight enough to catch a regression into one-call-per-chunk.
    expect(batches.length, "and should not over-split").to.be.at.most(3);

    // Every chunk is sized, and its padded limit fits under the ceiling — the property EIP-7825 requires.
    batches.forEach(({ calls: chunk, gasLimit }, idx) => {
      expect(chunk.length, `chunk ${idx} should not be empty`).to.be.greaterThan(0);
      expect(gasLimit, `chunk ${idx} should be sized`).to.not.be.undefined;
      const padded = Math.floor(gasLimit.toNumber() * MULTICALL3_BATCH_GAS_MULTIPLIER);
      expect(padded, `chunk ${idx} padded limit ${padded} should fit under the ceiling`).to.be.at.most(
        MULTICALL3_BATCH_GAS_CEILING
      );
    });

    // The chunks partition the batch, in order — nothing dropped, nothing duplicated.
    expect(batches.flatMap(({ calls: chunk }) => chunk)).to.deep.equal(calls);
  });

  it("Keeps every call succeeding at its chunk's own gas limit", async function () {
    const calls = burnCalls(6);
    const batches = await chunkFinalizationBatch(logger, chainId, multicall3, calls);
    const [{ address: from }] = await ethers.getSigners();

    for (const [idx, { calls: chunk, gasLimit }] of batches.entries()) {
      const data = multicall3.interface.encodeFunctionData("tryAggregate", [false, chunk]);
      const padded = Math.floor(gasLimit.toNumber() * MULTICALL3_BATCH_GAS_MULTIPLIER);
      const returned = await ethers.provider.call({ to: multicall3.address, data, from, gasLimit: padded });
      const [results] = multicall3.interface.decodeFunctionResult("tryAggregate", returned);
      expect(
        results.map((r: { success: boolean }) => r.success),
        `every call in chunk ${idx} should succeed at ${padded}`
      ).to.deep.equal(chunk.map(() => true));
    }
  });
});

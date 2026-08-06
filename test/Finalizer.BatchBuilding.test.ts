import { Multicall3__factory } from "@across-protocol/sdk/src/utils/abi/typechain";
import { BigNumber, Contract } from "ethers";
import {
  MULTICALL3_BATCH_GAS_CEILING,
  MULTICALL3_BATCH_GAS_MULTIPLIER,
  MULTICALL3_BATCH_GAS_OVERHEAD,
} from "../src/common";
import { buildFinalizationBatches } from "../src/finalizer";
import { CrossChainMessage } from "../src/finalizer/types";
import { Multicall2Call } from "../src/utils";
import { createSpyLogger, deployMulticall3, ethers, expect, getContractFactory } from "./utils";

// Sized against real Multicall3 bytecode. requireGas() is the OP-stack callWithMinGas shape — gated on gasleft()
// rather than on consumption, so an estimate of the batch can't see it.
describe("Finalizer batch building", function () {
  const { spyLogger: logger } = createSpyLogger();
  const chainId = 1;
  let multicall3: Contract,
    burner: Contract,
    nonce = 0;

  const call = (fn: string, ...args: number[]): Multicall2Call => ({
    target: burner.address,
    callData: burner.interface.encodeFunctionData(fn, args),
  });

  // buildFinalizationBatches() takes finalizations, so a call it can't size is reported as the message behind it.
  const finalization = (txn: Multicall2Call) => ({
    txn,
    crossChainMessage: {
      originationChainId: chainId,
      destinationChainId: chainId,
      type: "misc",
      miscReason: `test-${nonce++}`,
    } as CrossChainMessage,
  });

  const build = (calls: Multicall2Call[]) =>
    buildFinalizationBatches(logger, chainId, multicall3, calls.map(finalization));

  // What tryAggregate() reports per call, as opposed to whether the outer transaction succeeded.
  const succeeds = async (calls: Multicall2Call[], gasLimit: BigNumber): Promise<boolean[]> =>
    (await multicall3.callStatic.tryAggregate(false, calls, { gasLimit })).map(({ success }) => success);

  const pad = (gas: BigNumber): BigNumber => gas.mul(Math.round(MULTICALL3_BATCH_GAS_MULTIPLIER * 100)).div(100);

  before(async function () {
    const [signer] = await ethers.getSigners();
    await deployMulticall3(signer);
    multicall3 = new Contract("0xcA11bde05977b3631167028862bE2a173976CA11", Multicall3__factory.abi, signer);
    burner = await (await getContractFactory("MockGasBurner", signer)).deploy();
  });

  it("Sizes a batch past the gates an estimate of it can't see", async function () {
    const calls = [call("requireGas", 3_000_000), call("burn", 20), call("requireGas", 3_000_000)];
    const estimate = await multicall3.provider.estimateGas({
      from: multicall3.address,
      to: multicall3.address,
      data: multicall3.interface.encodeFunctionData("tryAggregate", [false, calls]),
    });
    expect(await succeeds(calls, estimate.mul(3).div(2))).to.deep.equal([false, true, false]);

    const { batches } = await build(calls);
    expect(await succeeds(calls, pad(batches[0].gasLimit))).to.deep.equal([true, true, true]);
  });

  // The summed estimates don't price the tryAggregate() wrapper. A multi-call batch absorbs that from the 21,000
  // intrinsic gas each estimate carries and the batch pays once; a lone call has no such slack, and a multiplier
  // proportional to a sum that excludes the wrapper can't supply it. The fixed overhead can.
  it("Sizes a lone call, which no proportional multiplier would cover", async function () {
    const calls = [call("burn", 20)];
    const { batches } = await build(calls);

    // Short of the allowance the whole transaction runs out of gas; it doesn't merely report the call as failed.
    const bare = pad(batches[0].gasLimit.sub(MULTICALL3_BATCH_GAS_OVERHEAD));
    expect(
      await succeeds(calls, bare).then(
        () => false,
        () => true
      )
    ).to.be.true;
    expect(await succeeds(calls, pad(batches[0].gasLimit))).to.deep.equal([true]);
  });

  // tryAggregate() contains a revert but not gas exhaustion, so a call nobody could size must not be charged
  // against a limit summed from its neighbours.
  it("Drops a call that no longer estimates", async function () {
    const calls = [call("burn", 20), call("burnThenFail", 4000), call("burn", 20)];
    const { batches, dropped } = await build(calls);

    expect(dropped.length).to.equal(1);
    expect(batches.flatMap(({ calls }) => calls)).to.deep.equal([calls[0], calls[2]]);
  });

  it("Splits over the ceiling, keeping each transaction submittable", async function () {
    const calls = [6_000_000, 6_000_000, 6_000_000].map((gas) => call("requireGas", gas));
    const { batches } = await build(calls);

    expect(batches.length).to.be.greaterThan(1);
    expect(batches.flatMap(({ calls }) => calls)).to.deep.equal(calls); // partitioned, in order
    for (const { calls, gasLimit } of batches) {
      expect(pad(gasLimit).lte(MULTICALL3_BATCH_GAS_CEILING)).to.be.true;
      expect(await succeeds(calls, pad(gasLimit))).to.not.include(false);
    }
  });
});

import { Multicall3__factory } from "@across-protocol/sdk/src/utils/abi/typechain";
import { Contract } from "ethers";
import { MULTICALL3_TRY_AGGREGATE_GAS_MULTIPLIER } from "../src/common";
import { deployMulticall3, ethers, expect, getContractFactory } from "./utils";

// Characterises eth_estimateGas against a real Multicall3 tryAggregate(requireSuccess=false) batch. The estimate is
// always a floor rather than a requirement, so MULTICALL3_TRY_AGGREGATE_GAS_MULTIPLIER stays load-bearing on the one
// path that still uses it: a batch whose calls have all stopped estimating. For the shapes below the shortfall is
// the EIP-150 reserve, but that bound holds only while a call's requirement follows what it consumes — it does not
// for OP-stack callWithMinGas, which is why finalization batches are sized from their calls rather than from an
// estimate of the batch. See src/clients/README.md, and test/Finalizer.BatchBuilding.test.ts for the sized path.
describe("Multicall3 tryAggregate gas estimation", function () {
  let multicall3: Contract, burner: Contract, from: string;

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
  });

  shapes.forEach(([label, rounds]) => {
    it(`Pads a batch with ${label} past its true requirement`, async function () {
      const calls = rounds.map((r) => ({
        target: burner.address,
        callData: burner.interface.encodeFunctionData("burn", [r]),
      }));
      const data = multicall3.interface.encodeFunctionData("tryAggregate", [false, calls]);

      // The lowest limit at which every inner call actually reports success: the batch's real requirement, as
      // opposed to what estimateGas reports.
      const allSucceed = async (gasLimit: number): Promise<boolean> => {
        try {
          const returned = await ethers.provider.call({ to: multicall3.address, data, from, gasLimit });
          const [results] = multicall3.interface.decodeFunctionResult("tryAggregate", returned);
          return results.length === calls.length && results.every((r: { success: boolean }) => r.success);
        } catch {
          return false;
        }
      };
      let [lo, hi] = [21_000, 12_000_000];
      expect(await allSucceed(hi), "batch should fit inside the bisection ceiling").to.be.true;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (await allSucceed(mid)) {
          hi = mid;
        } else {
          lo = mid + 1;
        }
      }
      const required = hi;
      const estimate = (await ethers.provider.estimateGas({ to: multicall3.address, data, from })).toNumber();

      // `at.most` rather than `below`: the shortfall vanishes into rounding once no single call dominates.
      expect(estimate, `estimate ${estimate} should not exceed requirement ${required}`).to.be.at.most(required);
      expect(required - estimate, `shortfall should be within 1/64 of ${required}`).to.be.at.most(
        Math.ceil(required / 64)
      );
      const padded = Math.floor(estimate * MULTICALL3_TRY_AGGREGATE_GAS_MULTIPLIER);
      expect(padded, `padded ${padded} should cover requirement ${required}`).to.be.at.least(required);
    });
  });
});

import { Multicall3__factory } from "@across-protocol/sdk/src/utils/abi/typechain";
import { Contract } from "ethers";
import { MULTICALL3_TRY_AGGREGATE_GAS_MULTIPLIER } from "../src/common";
import { deployMulticall3, ethers, expect, getContractFactory } from "./utils";

// Characterises eth_estimateGas against a real Multicall3 tryAggregate(requireSuccess=false) batch, pinning the
// two properties MULTICALL3_TRY_AGGREGATE_GAS_MULTIPLIER relies on: the estimate is always a floor rather than a
// requirement (so the padding is load-bearing — at 1.0x every case fails), and the shortfall is bounded by the
// EIP-150 reserve compounded over the batch's call-tree depth. See src/clients/README.md for why.
describe("Multicall3 tryAggregate gas estimation", function () {
  let multicall3: Contract, burner: Contract, from: string;

  // Frames a real finalization puts between tryAggregate and the gas it spends. A CCTP v2 mint reaches the
  // token's storage roughly this deep: transmitter proxy, its implementation, the messenger proxy and its
  // implementation, the minter, then the token's own proxy and implementation.
  const PROXIED_FINALIZATION_FRAMES = 7;

  // `rounds` sets each call's gas, `depth` how many further frames it spends that gas below. One large call is
  // the shallow case that matters — the withheld 1/64 is then the largest fraction of the batch — plus a
  // heterogeneous batch, a uniform one to show it converging, and a nested one standing in for a proxied target.
  const shapes: [string, number[], number][] = [
    ["a single large call", [8000], 0],
    ["a large call among small ones", [20, 20, 8000, 20], 0],
    ["uniformly sized calls", [1000, 1000, 1000, 1000, 1000], 0],
    ["a call nested behind proxies", [2000], PROXIED_FINALIZATION_FRAMES - 1],
  ];

  before(async function () {
    const [signer] = await ethers.getSigners();
    from = signer.address;
    await deployMulticall3(signer);
    multicall3 = new Contract("0xcA11bde05977b3631167028862bE2a173976CA11", Multicall3__factory.abi, signer);
    burner = await (await getContractFactory("MockGasBurner", signer)).deploy();
  });

  // Shape-independent, and the reason a fixed multiplier is enough: the shortfall is the reserve withheld at each
  // frame, so it is bounded once the deepest target is. Pinning the configured value against that bound covers
  // batch shapes the cases below don't reach — but only up to the depth asserted here.
  it("Configures a multiplier that clears the EIP-150 reserve at realistic nesting depth", function () {
    expect(MULTICALL3_TRY_AGGREGATE_GAS_MULTIPLIER).to.be.at.least(Math.pow(64 / 63, PROXIED_FINALIZATION_FRAMES));
  });

  shapes.forEach(([label, rounds, depth]) => {
    it(`Pads a batch with ${label} past its true requirement`, async function () {
      const calls = rounds.map((r) => ({
        target: burner.address,
        callData:
          depth === 0
            ? burner.interface.encodeFunctionData("burn", [r])
            : burner.interface.encodeFunctionData("burnNested", [depth, r]),
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
      // The reserve is withheld at every frame the gas passes through, so the bound compounds with depth: the
      // batch's own frame, plus one per frame the inner call spends its gas below. A flat 1/64 does not hold —
      // the nested shape above exceeds it.
      const bound = Math.ceil(estimate * Math.pow(64 / 63, depth + 1));
      expect(required, `requirement ${required} should be within the compounded reserve of ${estimate}`).to.be.at.most(
        bound
      );
      const padded = Math.floor(estimate * MULTICALL3_TRY_AGGREGATE_GAS_MULTIPLIER);
      expect(padded, `padded ${padded} should cover requirement ${required}`).to.be.at.least(required);
    });
  });
});

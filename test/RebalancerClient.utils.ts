import { ExcessOrDeficit, sortDeficitFunction, sortExcessFunction } from "../src/rebalancer/rebalancer";
import { BigNumber, expect } from "./utils";

describe("RebalancerClient.utils", () => {
  const MAINNET_CHAIN_ID = 1;

  function buildEntry(token: string, chainId: number, amount: BigNumber, priorityTier: number): ExcessOrDeficit {
    return { token, chainId, amount, priorityTier };
  }

  describe("sortDeficitFunction", () => {
    it("sorts by priority tier from highest to lowest", () => {
      const sorted = [
        buildEntry("DAI", MAINNET_CHAIN_ID, BigNumber.from("10"), 1),
        buildEntry("USDC", MAINNET_CHAIN_ID, BigNumber.from("1"), 3),
        buildEntry("USDT", MAINNET_CHAIN_ID, BigNumber.from("5"), 2),
      ].sort(sortDeficitFunction);

      expect(sorted.map((x) => x.token)).to.deep.equal(["USDC", "USDT", "DAI"]);
    });

    it("sorts same-priority deficits by normalized amount from largest to smallest", () => {
      const sorted = [
        buildEntry("USDC", MAINNET_CHAIN_ID, BigNumber.from("2000000"), 2), // 2.0 with 6 decimals
        buildEntry("DAI", MAINNET_CHAIN_ID, BigNumber.from("1000000000000000000"), 2), // 1.0 with 18 decimals
      ].sort(sortDeficitFunction);

      expect(sorted.map((x) => x.token)).to.deep.equal(["USDC", "DAI"]);
    });

    it("returns 0 for equal normalized amounts at same priority", () => {
      const comparison = sortDeficitFunction(
        buildEntry("USDC", MAINNET_CHAIN_ID, BigNumber.from("1000000"), 2),
        buildEntry("DAI", MAINNET_CHAIN_ID, BigNumber.from("1000000000000000000"), 2)
      );

      expect(comparison).to.equal(0);
    });
  });

  describe("sortExcessFunction", () => {
    it("sorts by priority tier from lowest to highest", () => {
      const sorted = [
        buildEntry("DAI", MAINNET_CHAIN_ID, BigNumber.from("10"), 2),
        buildEntry("USDC", MAINNET_CHAIN_ID, BigNumber.from("1"), 0),
        buildEntry("USDT", MAINNET_CHAIN_ID, BigNumber.from("5"), 1),
      ].sort(sortExcessFunction);

      expect(sorted.map((x) => x.token)).to.deep.equal(["USDC", "USDT", "DAI"]);
    });

    it("sorts same-priority excesses by normalized amount from largest to smallest", () => {
      const sorted = [
        buildEntry("DAI", MAINNET_CHAIN_ID, BigNumber.from("1000000000000000000"), 2), // 1.0 with 18 decimals
        buildEntry("USDC", MAINNET_CHAIN_ID, BigNumber.from("2000000"), 2), // 2.0 with 6 decimals
      ].sort(sortExcessFunction);

      expect(sorted.map((x) => x.token)).to.deep.equal(["USDC", "DAI"]);
    });

    it("returns 0 for equal normalized amounts at same priority", () => {
      const comparison = sortExcessFunction(
        buildEntry("USDC", MAINNET_CHAIN_ID, BigNumber.from("1000000"), 2),
        buildEntry("DAI", MAINNET_CHAIN_ID, BigNumber.from("1000000000000000000"), 2)
      );

      expect(comparison).to.equal(0);
    });
  });
});
